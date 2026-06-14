package queue

import (
	"context"
	"log/slog"
	"sync"
	"time"

	"github.com/redis/go-redis/v9"
	pb "github.com/realldz/tele-drive/backend-transfer-go/internal/grpc/proto"
	"github.com/realldz/tele-drive/backend-transfer-go/internal/storage"
	"github.com/realldz/tele-drive/backend-transfer-go/internal/telegram"
)

// pendingChunkResult pairs a chunk completion report with the temp file that
// backed it. The temp file is deleted only after the report is durably flushed
// to NestJS (the row flips buffered → complete), so a still-draining chunk stays
// downloadable from disk until Telegram becomes its source of truth.
type pendingChunkResult struct {
	result  *pb.ChunkResult
	tempKey string
}

type BatchReporter struct {
	client      CoreClient
	logger      *slog.Logger
	tempStorage *storage.TempStorage
	rdb         *redis.Client
	buffer      []pendingChunkResult
	bwBuffer    []*pb.BandwidthUsageEntry
	mu          sync.Mutex
	flushTicker *time.Ticker
	batchSize   int
	done        chan struct{}
}

func NewBatchReporter(client CoreClient, tempStorage *storage.TempStorage, rdb *redis.Client, logger *slog.Logger, interval time.Duration, batchSize int) *BatchReporter {
	br := &BatchReporter{
		client:      client,
		logger:      logger,
		tempStorage: tempStorage,
		rdb:         rdb,
		buffer:      make([]pendingChunkResult, 0, batchSize),
		bwBuffer:    make([]*pb.BandwidthUsageEntry, 0),
		flushTicker: time.NewTicker(interval),
		batchSize:   batchSize,
		done:        make(chan struct{}),
	}
	go br.startLoop()
	return br
}

func (br *BatchReporter) startLoop() {
	for {
		select {
		case <-br.flushTicker.C:
			br.Flush()
			br.flushBandwidth()
		case <-br.done:
			br.flushBandwidth()
			return
		}
	}
}

func (br *BatchReporter) Stop() {
	br.flushTicker.Stop()
	close(br.done)
	br.Flush()
}

// Report queues a chunk completion. tempKey (may be empty) is the temp file that
// backed this chunk; it is deleted only after the result is durably flushed to
// NestJS, so the chunk stays downloadable from disk until its row says complete.
func (br *BatchReporter) Report(result *pb.ChunkResult, tempKey string) {
	br.mu.Lock()
	br.buffer = append(br.buffer, pendingChunkResult{result: result, tempKey: tempKey})
	shouldFlush := len(br.buffer) >= br.batchSize
	br.mu.Unlock()

	if shouldFlush {
		br.Flush()
	}
}

func (br *BatchReporter) Flush() {
	br.mu.Lock()
	if len(br.buffer) == 0 {
		br.mu.Unlock()
		return
	}

	// Copy buffer to avoid holding lock during RPC
	batch := make([]pendingChunkResult, len(br.buffer))
	copy(batch, br.buffer)
	br.buffer = br.buffer[:0]
	br.mu.Unlock()

	results := make([]*pb.ChunkResult, len(batch))
	for i, p := range batch {
		results[i] = p.result
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	accepted, err := br.client.ReportChunkResults(ctx, results)
	if err != nil {
		br.logger.Error("Failed to report chunk results, buffering for retry", "error", err)
		// Put back in buffer — keep the temp files so the retry can still serve
		// downloads and (if the chunk needs re-upload) the data survives.
		br.mu.Lock()
		br.buffer = append(batch, br.buffer...)
		br.mu.Unlock()
		return
	}

	// The rows are now durably complete in NestJS (Telegram is the source of
	// truth), so the temp files are safe to delete. Doing it only here closes the
	// window where a chunk's DB row still said buffered+tempKey but its temp file
	// had already been removed — which would break a download mid-stream.
	for _, p := range batch {
		if p.tempKey != "" {
			_ = br.tempStorage.Delete(p.tempKey)
		}
	}

	// Durable-flush DECR of the outstanding counter (see outstanding_counter.go).
	// This is the success-path decrement deliberately moved OUT of the worker: only
	// now is the chunk confirmed persisted in the NestJS DB, so a cross-instance
	// flushAndConfirm will see it in `completed`. Decrementing earlier (at upload)
	// would let a chunk fall out of both `completed` and `outstanding`. Grouped by
	// fileId so a multi-chunk batch for one file is a single DECRBY.
	counts := make(map[string]int)
	for _, p := range batch {
		counts[p.result.FileId]++
	}
	for fileID, n := range counts {
		decrOutstanding(context.Background(), br.rdb, br.logger, fileID, n)
	}

	br.logger.Info("Flushed chunk results via gRPC", "count", len(batch), "accepted", accepted)
}

// FlushForFile ensures all chunks for a specific file are flushed immediately
func (br *BatchReporter) FlushForFile(fileID string) {
	br.Flush()
}

func (br *BatchReporter) ReportBandwidth(report *telegram.BandwidthReport) {
	br.mu.Lock()
	br.bwBuffer = append(br.bwBuffer, &pb.BandwidthUsageEntry{
		UserId:        report.UserID,
		FileId:        report.FileID,
		ActualBytes:   report.ActualBytes,
		CountDownload: report.CountDownload,
	})
	br.mu.Unlock()
}

func (br *BatchReporter) flushBandwidth() {
	br.mu.Lock()
	if len(br.bwBuffer) == 0 {
		br.mu.Unlock()
		return
	}
	bwBatch := make([]*pb.BandwidthUsageEntry, len(br.bwBuffer))
	copy(bwBatch, br.bwBuffer)
	br.bwBuffer = br.bwBuffer[:0]
	br.mu.Unlock()

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := br.client.ReportBandwidthUsage(ctx, bwBatch); err != nil {
		br.logger.Error("Failed to report bandwidth usage, buffering for retry", "error", err)
		br.mu.Lock()
		br.bwBuffer = append(bwBatch, br.bwBuffer...)
		br.mu.Unlock()
	} else {
		br.logger.Debug("Flushed bandwidth reports via gRPC", "count", len(bwBatch))
	}
}
