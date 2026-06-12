package grpc

import (
	"context"
	"fmt"
	"log/slog"
	"net"
	"time"

	pb "github.com/realldz/tele-drive/backend-transfer-go/internal/grpc/proto"
	"google.golang.org/grpc"
	"google.golang.org/grpc/keepalive"
)

type TransferServer struct {
	pb.UnimplementedTransferServiceServer
	logger *slog.Logger
}

func NewTransferServer(logger *slog.Logger) *TransferServer {
	return &TransferServer{logger: logger}
}

func (s *TransferServer) Ping(ctx context.Context, req *pb.TransferPingRequest) (*pb.TransferPingResponse, error) {
	return &pb.TransferPingResponse{Timestamp: time.Now().UnixMilli()}, nil
}

func (s *TransferServer) FlushAndConfirm(ctx context.Context, req *pb.FlushAndConfirmRequest) (*pb.FlushAndConfirmResponse, error) {
	s.logger.Info("FlushAndConfirm called (stub)", "fileId", req.FileId)
	return &pb.FlushAndConfirmResponse{
		AllComplete:     false,
		TotalChunks:     0,
		CompletedChunks: 0,
		Chunks:          nil,
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
