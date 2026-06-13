package grpc

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	pb "github.com/realldz/tele-drive/backend-transfer-go/internal/grpc/proto"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/keepalive"
)

type CoreClient struct {
	conn   *grpc.ClientConn
	client pb.CoreServiceClient
	logger *slog.Logger
}

func NewCoreClient(nestjsURL string, logger *slog.Logger) (*CoreClient, error) {
	conn, err := grpc.NewClient(nestjsURL,
		grpc.WithTransportCredentials(insecure.NewCredentials()),
		grpc.WithKeepaliveParams(keepalive.ClientParameters{
			Time:                30 * time.Second,
			Timeout:             10 * time.Second,
			PermitWithoutStream: true,
		}),
		grpc.WithDefaultCallOptions(
			grpc.MaxCallRecvMsgSize(10*1024*1024),
			grpc.MaxCallSendMsgSize(10*1024*1024),
		),
	)
	if err != nil {
		return nil, fmt.Errorf("failed to connect to NestJS gRPC: %w", err)
	}

	client := pb.NewCoreServiceClient(conn)
	return &CoreClient{conn: conn, client: client, logger: logger}, nil
}

func (c *CoreClient) Close() error {
	return c.conn.Close()
}

func (c *CoreClient) Ping(ctx context.Context) (*pb.Pong, error) {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	return c.client.Ping(ctx, &pb.Empty{})
}

func (c *CoreClient) ReportChunkResults(ctx context.Context, results []*pb.ChunkResult) (int32, error) {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	resp, err := c.client.ReportChunkResults(ctx, &pb.ReportChunkResultsRequest{Results: results})
	if err != nil {
		return 0, err
	}
	return resp.Accepted, nil
}

func (c *CoreClient) ReportFileComplete(ctx context.Context, req *pb.ReportFileCompleteRequest) error {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	_, err := c.client.ReportFileComplete(ctx, req)
	return err
}

func (c *CoreClient) GetFileMetadata(ctx context.Context, fileID string) (*pb.FileMetadata, error) {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	return c.client.GetFileMetadata(ctx, &pb.GetFileMetadataRequest{FileId: fileID})
}

// GetS3Credential resolves an accessKeyId to its decrypted secret + owning
// userId. NestJS returns Found=false (not a gRPC NotFound status) when the
// access key is unknown — callers must inspect resp.Found, not status.Code.
func (c *CoreClient) GetS3Credential(ctx context.Context, accessKeyID string) (*pb.GetS3CredentialResponse, error) {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	return c.client.GetS3Credential(ctx, &pb.GetS3CredentialRequest{AccessKeyId: accessKeyID})
}

// ResolveS3Object resolves a (bucket, key) pair to a FileRecord for GET/HEAD.
func (c *CoreClient) ResolveS3Object(ctx context.Context, userID, bucket, key string) (*pb.ResolveS3ObjectResponse, error) {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	return c.client.ResolveS3Object(ctx, &pb.ResolveS3ObjectRequest{
		UserId: userID,
		Bucket: bucket,
		Key:    key,
	})
}

// PrepareS3Put creates an uploading FileRecord placeholder and provisions
// encryption upfront so Go can ingest the body stream.
func (c *CoreClient) PrepareS3Put(ctx context.Context, req *pb.PrepareS3PutRequest) (*pb.PrepareS3PutResponse, error) {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	return c.client.PrepareS3Put(ctx, req)
}

// ReportS3PutComplete finalizes an S3 PUT after Go uploads to Telegram.
func (c *CoreClient) ReportS3PutComplete(ctx context.Context, req *pb.ReportS3PutCompleteRequest) error {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	_, err := c.client.ReportS3PutComplete(ctx, req)
	return err
}

func (c *CoreClient) BatchCheckChunkStatus(ctx context.Context, fileIDs []string) ([]*pb.ChunkStatusEntry, error) {
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	resp, err := c.client.BatchCheckChunkStatus(ctx, &pb.BatchCheckRequest{FileIds: fileIDs})
	if err != nil {
		return nil, err
	}
	return resp.Entries, nil
}

func (c *CoreClient) ReportUploadFailed(ctx context.Context, req *pb.ReportUploadFailedRequest) error {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	_, err := c.client.ReportUploadFailed(ctx, req)
	return err
}

func (c *CoreClient) ReportBandwidthUsage(ctx context.Context, entries []*pb.BandwidthUsageEntry) error {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	_, err := c.client.ReportBandwidthUsage(ctx, &pb.ReportBandwidthUsageRequest{Entries: entries})
	return err
}

// GetBandwidthQuota fetches the current quota snapshot (user/guest daily +
// per-file counters) so the Go data plane can seed its Redis quota hash on a
// cache miss. Read-only on the NestJS side — no DB mutation.
func (c *CoreClient) GetBandwidthQuota(ctx context.Context, userID, ip, fileID string) (*pb.GetBandwidthQuotaResponse, error) {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	return c.client.GetBandwidthQuota(ctx, &pb.GetBandwidthQuotaRequest{
		UserId: userID,
		Ip:     ip,
		FileId: fileID,
	})
}

func (c *CoreClient) ReportDeleteSuccess(ctx context.Context, fileID string) error {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	_, err := c.client.ReportDeleteSuccess(ctx, &pb.ReportDeleteSuccessRequest{FileId: fileID})
	return err
}

func (c *CoreClient) ReportDeleteFailed(ctx context.Context, fileID string, reason string) error {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	_, err := c.client.ReportDeleteFailed(ctx, &pb.ReportDeleteFailedRequest{FileId: fileID, Reason: reason})
	return err
}

func (c *CoreClient) ReportFileCorrupted(ctx context.Context, fileID string, telegramFileID string) error {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	_, err := c.client.ReportFileCorrupted(ctx, &pb.ReportFileCorruptedRequest{FileId: fileID, TelegramFileId: telegramFileID})
	return err
}

func (c *CoreClient) ReportZipReady(ctx context.Context, req *pb.ReportZipReadyRequest) error {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	_, err := c.client.ReportZipReady(ctx, req)
	return err
}

func (c *CoreClient) ReportZipFailed(ctx context.Context, jobID string, reason string) error {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	_, err := c.client.ReportZipFailed(ctx, &pb.ReportZipFailedRequest{JobId: jobID, Reason: reason})
	return err
}

func (c *CoreClient) CollectZipEntries(ctx context.Context, jobID string) ([]*pb.ZipEntry, error) {
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	resp, err := c.client.CollectZipEntries(ctx, &pb.CollectZipEntriesRequest{JobId: jobID})
	if err != nil {
		return nil, err
	}
	return resp.Entries, nil
}

func (c *CoreClient) ReportZipProgress(ctx context.Context, jobID string, processedFiles int32) error {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	_, err := c.client.ReportZipProgress(ctx, &pb.ReportZipProgressRequest{JobId: jobID, ProcessedFiles: processedFiles})
	return err
}

func (c *CoreClient) ReportEmergencyCleanup(ctx context.Context, fileIDs []string) error {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	_, err := c.client.ReportEmergencyCleanup(ctx, &pb.ReportEmergencyCleanupRequest{FileIds: fileIDs})
	return err
}

func (c *CoreClient) CheckDiskSpace(ctx context.Context) (*pb.DiskSpaceResponse, error) {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	return c.client.CheckDiskSpace(ctx, &pb.Empty{})
}

func (c *CoreClient) VerifyFolderShare(ctx context.Context, shareToken string, fileID string) (*pb.VerifyFolderShareResponse, error) {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	return c.client.VerifyFolderShare(ctx, &pb.VerifyFolderShareRequest{
		ShareToken: shareToken,
		FileId:     fileID,
	})
}

func (c *CoreClient) IsConnected() bool {
	state := c.conn.GetState()
	return state.String() == "READY" || state.String() == "IDLE"
}
