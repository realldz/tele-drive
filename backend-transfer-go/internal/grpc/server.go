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

func (s *TransferServer) FlushAndConfirm(ctx context.Context, req *pb.FlushAndConfirmRequest) (*pb.FlushAndConfirmResponse, error) {
	s.logger.Info("FlushAndConfirm called", "fileId", req.FileId)
	
	// 1. Wait for active workers processing this file (max 15s)
	s.workerPool.WaitForFile(req.FileId, 15*time.Second)
	
	// 2. Flush any buffered results for this file
	s.batchReporter.FlushForFile(req.FileId)
	
	// 3. Query NestJS for final metadata to verify
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
	
	return &pb.FlushAndConfirmResponse{
		AllComplete:     completedChunks == int(meta.TotalChunks),
		TotalChunks:     meta.TotalChunks,
		CompletedChunks: int32(completedChunks),
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
