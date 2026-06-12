package queue

import (
	"context"
	"log/slog"
	"sync"
	"sync/atomic"
	"time"
)

type ChunkJob struct {
	ID             string
	FileID         string
	ChunkIndex     int
	Size           int
	TempStorageKey string
	UserID         string
	Attempt        int
}

type WorkerPool struct {
	jobs         chan ChunkJob
	delayedQueue chan ChunkJob
	processor    *UploadWorker
	logger       *slog.Logger
	ctx          context.Context
	cancel       context.CancelFunc
	wg           sync.WaitGroup
	activeJobs   atomic.Int32
	
	// Tracking active file uploads for synchronous confirmation
	fileJobsMu   sync.Mutex
	fileJobs     map[string]int32 // Count of active jobs per file
}

func NewWorkerPool(size int, processor *UploadWorker, logger *slog.Logger) *WorkerPool {
	ctx, cancel := context.WithCancel(context.Background())
	pool := &WorkerPool{
		jobs:         make(chan ChunkJob, 1000),
		delayedQueue: make(chan ChunkJob, 1000),
		processor:    processor,
		logger:       logger,
		ctx:          ctx,
		cancel:       cancel,
		fileJobs:     make(map[string]int32),
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

func (p *WorkerPool) AddJob(job ChunkJob) {
	p.fileJobsMu.Lock()
	p.fileJobs[job.FileID]++
	p.fileJobsMu.Unlock()
	
	p.jobs <- job
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
					p.delayedQueue <- job
				} else {
					p.logger.Error("Upload permanently failed", "chunkId", job.ID, "error", err)
					p.processor.ReportFailure(job.FileID, job.ChunkIndex, err.Error())
					p.decrementFileJob(job.FileID)
				}
			} else {
				p.decrementFileJob(job.FileID)
			}
			
			p.activeJobs.Add(-1)
		}
	}
}

func (p *WorkerPool) decrementFileJob(fileID string) {
	p.fileJobsMu.Lock()
	defer p.fileJobsMu.Unlock()
	
	p.fileJobs[fileID]--
	if p.fileJobs[fileID] <= 0 {
		delete(p.fileJobs, fileID)
	}
}

// WaitForFile waits until all active jobs for a specific file complete
func (p *WorkerPool) WaitForFile(fileID string, timeout time.Duration) bool {
	deadline := time.Now().Add(timeout)
	
	for time.Now().Before(deadline) {
		p.fileJobsMu.Lock()
		count := p.fileJobs[fileID]
		p.fileJobsMu.Unlock()
		
		if count <= 0 {
			return true
		}
		time.Sleep(100 * time.Millisecond)
	}
	return false
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
					p.jobs <- item.job
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
		p.wg.Wait()
		close(done)
	}()

	select {
	case <-done:
	case <-time.After(timeout):
		p.logger.Warn("Graceful shutdown timeout reached")
	}
}
