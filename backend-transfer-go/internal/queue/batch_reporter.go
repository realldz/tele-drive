package queue

import (
	"context"
	"log/slog"
	"sync"
	"time"

	pb "github.com/realldz/tele-drive/backend-transfer-go/internal/grpc/proto"
)

type BatchReporter struct {
	client      CoreClient
	logger      *slog.Logger
	buffer      []*pb.ChunkResult
	mu          sync.Mutex
	flushTicker *time.Ticker
	batchSize   int
	done        chan struct{}
}

func NewBatchReporter(client CoreClient, logger *slog.Logger, interval time.Duration, batchSize int) *BatchReporter {
	br := &BatchReporter{
		client:      client,
		logger:      logger,
		buffer:      make([]*pb.ChunkResult, 0, batchSize),
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
		case <-br.done:
			return
		}
	}
}

func (br *BatchReporter) Stop() {
	br.flushTicker.Stop()
	close(br.done)
	br.Flush()
}

func (br *BatchReporter) Report(result *pb.ChunkResult) {
	br.mu.Lock()
	br.buffer = append(br.buffer, result)
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
	batch := make([]*pb.ChunkResult, len(br.buffer))
	copy(batch, br.buffer)
	br.buffer = br.buffer[:0]
	br.mu.Unlock()

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	accepted, err := br.client.ReportChunkResults(ctx, batch)
	if err != nil {
		br.logger.Error("Failed to report chunk results, buffering for retry", "error", err)
		// Put back in buffer
		br.mu.Lock()
		br.buffer = append(batch, br.buffer...)
		br.mu.Unlock()
		return
	}

	br.logger.Info("Flushed chunk results via gRPC", "count", len(batch), "accepted", accepted)
}

// FlushForFile ensures all chunks for a specific file are flushed immediately
func (br *BatchReporter) FlushForFile(fileID string) {
	br.Flush()
}
