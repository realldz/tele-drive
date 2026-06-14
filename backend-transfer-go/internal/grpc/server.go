package grpc

import (
	"context"
	"fmt"
	"log/slog"
	"net"
	"time"

	pb "github.com/realldz/tele-drive/backend-transfer-go/internal/grpc/proto"
	"github.com/realldz/tele-drive/backend-transfer-go/internal/queue"
	"google.golang.org/grpc"
	"google.golang.org/grpc/keepalive"
)

type TransferServer struct {
	pb.UnimplementedTransferServiceServer
	logger        *slog.Logger
	workerPool    *queue.WorkerPool
	batchReporter *queue.BatchReporter
	coreClient    *CoreClient
}

func NewTransferServer(logger *slog.Logger, pool *queue.WorkerPool, reporter *queue.BatchReporter, client *CoreClient) *TransferServer {
	return &TransferServer{
		logger:        logger,
		workerPool:    pool,
		batchReporter: reporter,
		coreClient:    client,
	}
}

func (s *TransferServer) Ping(ctx context.Context, req *pb.TransferPingRequest) (*pb.TransferPingResponse, error) {
	return &pb.TransferPingResponse{Timestamp: time.Now().UnixMilli()}, nil
}

func (s *TransferServer) EnqueueBufferedUpload(ctx context.Context, req *pb.EnqueueBufferedUploadRequest) (*pb.EnqueueBufferedUploadResponse, error) {
	job := queue.ChunkJob{
		ID:             req.FileId,
		FileID:         req.FileId,
		ChunkIndex:     int(req.ChunkIndex),
		Size:           int(req.Size),
		TempStorageKey: req.TempStorageKey,
		UserID:         req.UserId,
		Attempt:        0,
		IsChunked:      req.IsChunk,
	}

	if err := s.workerPool.AddJob(job); err != nil {
		s.logger.Warn("Rejected buffered upload enqueue", "fileId", req.FileId, "isChunk", req.IsChunk, "error", err)
		return &pb.EnqueueBufferedUploadResponse{Accepted: false, Reason: err.Error()}, nil
	}

	s.logger.Info("Enqueued buffered upload", "fileId", req.FileId, "isChunk", req.IsChunk, "chunkIndex", req.ChunkIndex)
	return &pb.EnqueueBufferedUploadResponse{Accepted: true}, nil
}

func (s *TransferServer) FlushAndConfirm(ctx context.Context, req *pb.FlushAndConfirmRequest) (*pb.FlushAndConfirmResponse, error) {
	s.logger.Info("FlushAndConfirm called", "fileId", req.FileId)

	// Buffered chunks return 200 to the client the instant they hit the worker
	// queue, long before they reach Telegram (worker count + per-bot rate limiting
	// pace the actual upload). The whole point of the async buffer is that the
	// client never waits for Telegram, so we DO NOT block here until the queue
	// drains. Instead we report two counts and let NestJS park the record as
	// "buffered" — the background worker flips it to "complete" as chunks land.
	//
	//   completed = chunks already on Telegram and persisted in NestJS (DB-backed)
	//   received  = completed + still-draining jobs Go holds for this file
	//
	// "received" answers the client's real question — "did I hand over every
	// chunk?" — without waiting for the slow Telegram leg.

	// Flush buffered chunk results so NestJS DB reflects everything the workers
	// have finished uploading up to this instant.
	s.batchReporter.FlushForFile(req.FileId)

	// Jobs still queued / in-flight / awaiting retry for this file.
	outstanding := s.workerPool.OutstandingForFile(req.FileId)

	// Query NestJS for final metadata to count what has actually landed.
	meta, err := s.coreClient.GetFileMetadata(ctx, req.FileId)
	if err != nil {
		return nil, fmt.Errorf("failed to fetch metadata: %w", err)
	}

	completedChunks := 0
	var confirmed []*pb.ChunkConfirmation

	for _, c := range meta.Chunks {
		if c.TelegramFileId != "" {
			completedChunks++
			confirmed = append(confirmed, &pb.ChunkConfirmation{
				ChunkIndex:        c.ChunkIndex,
				TelegramFileId:    c.TelegramFileId,
				TelegramMessageId: c.TelegramMessageId,
				BotId:             c.BotId,
				EncryptionIv:      c.EncryptionIv,
				Size:              c.Size,
				Etag:              c.Etag,
			})
		}
	}

	receivedChunks := completedChunks + int(outstanding)
	if receivedChunks > int(meta.TotalChunks) {
		// Tiny window: a worker reported its chunk to the batch (now flushed to
		// DB) but has not yet decremented the outstanding counter. Clamp so we
		// never claim more chunks than the file declares.
		receivedChunks = int(meta.TotalChunks)
	}

	s.logger.Info("FlushAndConfirm result",
		"fileId", req.FileId,
		"completed", completedChunks,
		"outstanding", outstanding,
		"received", receivedChunks,
		"total", meta.TotalChunks)

	return &pb.FlushAndConfirmResponse{
		AllComplete:     completedChunks == int(meta.TotalChunks),
		TotalChunks:     meta.TotalChunks,
		CompletedChunks: int32(completedChunks),
		ReceivedChunks:  int32(receivedChunks),
		AllReceived:     receivedChunks == int(meta.TotalChunks),
		Chunks:          confirmed,
	}, nil
}

func StartGRPCServer(ctx context.Context, port int, server *TransferServer, logger *slog.Logger) error {
	lis, err := net.Listen("tcp", fmt.Sprintf(":%d", port))
	if err != nil {
		return fmt.Errorf("failed to listen on gRPC port %d: %w", port, err)
	}

	grpcServer := grpc.NewServer(
		grpc.KeepaliveParams(keepalive.ServerParameters{
			Time:    30 * time.Second,
			Timeout: 10 * time.Second,
		}),
		grpc.KeepaliveEnforcementPolicy(keepalive.EnforcementPolicy{
			MinTime:             10 * time.Second,
			PermitWithoutStream: true,
		}),
	)

	pb.RegisterTransferServiceServer(grpcServer, server)

	go func() {
		<-ctx.Done()
		logger.Info("Stopping gRPC server...")
		grpcServer.GracefulStop()
	}()

	logger.Info("gRPC server starting", "port", port)
	return grpcServer.Serve(lis)
}
