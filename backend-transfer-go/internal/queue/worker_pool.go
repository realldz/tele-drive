package queue

import (
	"context"
	"errors"
	"log/slog"
	"sync"
	"sync/atomic"
	"time"

	"github.com/redis/go-redis/v9"
)

type ChunkJob struct {
	ID             string
	FileID         string
	ChunkIndex     int
	Size           int
	TempStorageKey string
	UserID         string
	Attempt        int
	IsChunked      bool
}

var ErrBufferFull = errors.New("upload buffer is full")

type WorkerPool struct {
	jobs         chan ChunkJob
	delayedQueue chan ChunkJob
	processor    *UploadWorker
	logger       *slog.Logger
	ctx          context.Context
	cancel       context.CancelFunc
	wg           sync.WaitGroup
	activeJobs   atomic.Int32
	workerCount  int

	// Per-file outstanding-chunk counter lives in Redis (see outstanding_counter.go),
	// not an in-memory map: chunk uploads and the completing flushAndConfirm reach
	// DIFFERENT instances, so the count must be shared. The success-path decrement is
	// owned by BatchReporter (at durable flush), not this pool — see the invariant in
	// outstanding_counter.go.
	rdb *redis.Client
}

func NewWorkerPool(size int, processor *UploadWorker, rdb *redis.Client, logger *slog.Logger) *WorkerPool {
	ctx, cancel := context.WithCancel(context.Background())
	pool := &WorkerPool{
		jobs:         make(chan ChunkJob, 1000),
		delayedQueue: make(chan ChunkJob, 1000),
		processor:    processor,
		logger:       logger,
		ctx:          ctx,
		cancel:       cancel,
		rdb:          rdb,
		workerCount:  size,
	}

	// Start delayed queue manager
	pool.wg.Add(1)
	go pool.manageDelayedQueue()

	// Start workers
	for i := 0; i < size; i++ {
		pool.wg.Add(1)
		go pool.worker(i)
	}

	return pool
}

func (p *WorkerPool) AddJob(job ChunkJob) error {
	if len(p.jobs) >= 900 {
		return ErrBufferFull
	}

	select {
	case p.jobs <- job:
		// INCR only after the job is safely queued, so a full-channel reject needs no
		// rollback. The matching success-path DECR happens in BatchReporter at durable
		// flush; failure/discard branches DECR in worker().
		incrOutstanding(p.ctx, p.rdb, p.logger, job.FileID)
		return nil
	default:
		return ErrBufferFull
	}
}

func (p *WorkerPool) worker(id int) {
	defer p.wg.Done()

	for {
		select {
		case <-p.ctx.Done():
			p.logger.Info("Worker stopping", "id", id)
			return
		case job := <-p.jobs:
			p.activeJobs.Add(1)
			
			err := p.processor.ProcessInternalChunk(p.ctx, job)
			
			if err != nil {
				// Retry logic
				if job.Attempt < 5 {
					p.logger.Warn("Upload failed, scheduling retry", "chunkId", job.ID, "attempt", job.Attempt+1, "error", err)
					job.Attempt++
					select {
					case p.delayedQueue <- job:
					default:
						// Discarded before reaching the reporter — this chunk never gets a
						// durable-flush DECR, so DECR here to keep the invariant.
						p.logger.Error("Delayed queue full, discarding retry", "chunkId", job.ID)
						p.processor.ReportFailure(job.FileID, job.ChunkIndex, "delayed_queue_full")
						decrOutstanding(p.ctx, p.rdb, p.logger, job.FileID, 1)
					}
				} else {
					// Permanent failure — never reaches the reporter, so DECR here.
					p.logger.Error("Upload permanently failed", "chunkId", job.ID, "error", err)
					p.processor.ReportFailure(job.FileID, job.ChunkIndex, err.Error())
					decrOutstanding(p.ctx, p.rdb, p.logger, job.FileID, 1)
				}
			}
			// Success path intentionally does NOT decrement here: the chunk is on
			// Telegram but only QUEUED in the BatchReporter, not yet durable in the
			// NestJS DB. The matching DECR happens in BatchReporter.Flush once the
			// result is confirmed persisted, so a cross-instance flushAndConfirm never
			// sees the chunk fall out of both `completed` and `outstanding`.

			p.activeJobs.Add(-1)
		}
	}
}

// OutstandingForFile returns the number of buffered chunks for a file that are
// accepted but not yet durably persisted in the NestJS DB (queued, in-flight, or
// awaiting retry). Backed by a shared Redis counter so every instance sees the
// same number regardless of which instance the chunk uploads or the gRPC
// flushAndConfirm landed on. FlushAndConfirm adds this to the chunks already
// landed on Telegram to compute how many the client has handed over in total.
func (p *WorkerPool) OutstandingForFile(fileID string) int32 {
	return getOutstanding(p.ctx, p.rdb, p.logger, fileID)
}

func (p *WorkerPool) manageDelayedQueue() {
	defer p.wg.Done()
	
	ticker := time.NewTicker(500 * time.Millisecond)
	defer ticker.Stop()
	
	type delayedItem struct {
		job ChunkJob
		at  time.Time
	}
	var delayed []delayedItem

	for {
		select {
		case <-p.ctx.Done():
			return
		case job := <-p.delayedQueue:
			delay := time.Duration(1<<job.Attempt) * time.Second
			delayed = append(delayed, delayedItem{job: job, at: time.Now().Add(delay)})
			
		case <-ticker.C:
			now := time.Now()
			var remaining []delayedItem

			for _, item := range delayed {
				if now.After(item.at) {
					select {
					case p.jobs <- item.job:
					default:
						remaining = append(remaining, item)
					}
				} else {
					remaining = append(remaining, item)
				}
			}
			delayed = remaining
		}
	}
}

func (p *WorkerPool) Stop() {
	p.cancel()
}

func (p *WorkerPool) WaitForCompletion(timeout time.Duration) {
	done := make(chan struct{})

	go func() {
		ticker := time.NewTicker(100 * time.Millisecond)
		defer ticker.Stop()

		for {
			if p.activeJobs.Load() == 0 {
				close(done)
				return
			}
			<-ticker.C
		}
	}()

	select {
	case <-done:
		p.logger.Info("All workers finished cleanly")
	case <-time.After(timeout):
		p.logger.Warn("Graceful shutdown timeout, forcing exit", "incompleteJobs", p.activeJobs.Load())
	}
}

func (p *WorkerPool) Size() int {
	return p.workerCount
}

func (p *WorkerPool) GetJobs() chan ChunkJob {
	return p.jobs
}

func (p *WorkerPool) ActiveCount() int32 {
	return p.activeJobs.Load()
}

func (p *WorkerPool) PendingCount() int {
	return len(p.jobs)
}

func (p *WorkerPool) DelayedCount() int {
	return len(p.delayedQueue)
}
