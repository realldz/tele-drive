package queue

import (
	"context"
	"crypto/md5"
	"encoding/hex"
	"fmt"
	"io"
	"log/slog"

	"github.com/realldz/tele-drive/backend-transfer-go/internal/crypto"
	pb "github.com/realldz/tele-drive/backend-transfer-go/internal/grpc/proto"
	"github.com/realldz/tele-drive/backend-transfer-go/internal/storage"
	"github.com/realldz/tele-drive/backend-transfer-go/internal/telegram"
)

type CoreClient interface {
	ReportChunkResults(ctx context.Context, results []*pb.ChunkResult) (int32, error)
	GetFileMetadata(ctx context.Context, fileID string) (*pb.FileMetadata, error)
	ReportUploadFailed(ctx context.Context, req *pb.ReportUploadFailedRequest) error
}

type UploadWorker struct {
	grpcClient     CoreClient
	batchReporter  *BatchReporter
	telegramClient *telegram.TelegramClient
	cryptoEngine   *crypto.CryptoEngine
	tempStorage    *storage.TempStorage
	logger         *slog.Logger
}

func NewUploadWorker(
	grpcClient CoreClient,
	batchReporter *BatchReporter,
	telegramClient *telegram.TelegramClient,
	cryptoEngine *crypto.CryptoEngine,
	tempStorage *storage.TempStorage,
	logger *slog.Logger,
) *UploadWorker {
	return &UploadWorker{
		grpcClient:     grpcClient,
		batchReporter:  batchReporter,
		telegramClient: telegramClient,
		cryptoEngine:   cryptoEngine,
		tempStorage:    tempStorage,
		logger:         logger,
	}
}

type countingWriter struct {
	w     io.Writer
	count int64
}

func (cw *countingWriter) Write(p []byte) (n int, err error) {
	n, err = cw.w.Write(p)
	cw.count += int64(n)
	return n, err
}

func (uw *UploadWorker) ProcessInternalChunk(ctx context.Context, job ChunkJob) error {
	// Fetch metadata via gRPC instead of DB
	meta, err := uw.grpcClient.GetFileMetadata(ctx, job.FileID)
	if err != nil {
		return err
	}

	dek, err := uw.cryptoEngine.DecryptKey(meta.EncryptedKey)
	if err != nil {
		return err
	}

	ivBytes, _ := uw.cryptoEngine.GenerateIv()

	src, err := uw.tempStorage.Read(job.TempStorageKey)
	if err != nil {
		return err
	}
	defer src.Close()

	hash := md5.New()
	counter := &countingWriter{w: hash}
	tee := io.TeeReader(src, counter)

	var encryptedStream io.Reader = tee
	if meta.IsEncrypted {
		encryptedStream, err = uw.cryptoEngine.EncryptStream(tee, dek, ivBytes)
		if err != nil {
			return err
		}
	}

	partFilename := fmt.Sprintf("%s.part%03d", job.FileID, job.ChunkIndex)
	telegramFileID, telegramMessageID, botID, err := uw.telegramClient.UploadFile(ctx, encryptedStream, partFilename, int64(job.Size))
	if err != nil {
		return err
	}

	md5Hex := hex.EncodeToString(hash.Sum(nil))

	// Report via gRPC batcher instead of DB transaction
	uw.batchReporter.Report(&pb.ChunkResult{
		FileId:            job.FileID,
		ChunkIndex:        int32(job.ChunkIndex),
		TelegramFileId:    telegramFileID,
		TelegramMessageId: int32(telegramMessageID),
		BotId:             botID,
		EncryptionIv:      hex.EncodeToString(ivBytes),
		Size:              int32(counter.count),
		Etag:              fmt.Sprintf("\"%s\"", md5Hex),
		ChunkId:           job.ID,
	})

	_ = uw.tempStorage.Delete(job.TempStorageKey)
	uw.logger.Info("Chunk dispatched via gRPC", "chunkIndex", job.ChunkIndex, "fileId", job.FileID)

	return nil
}

func (uw *UploadWorker) ReportFailure(fileID string, chunkIndex int, reason string) {
	req := &pb.ReportUploadFailedRequest{
		FileId:     fileID,
		ChunkIndex: int32(chunkIndex),
		Reason:     reason,
		IsChunk:    true,
	}
	_ = uw.grpcClient.ReportUploadFailed(context.Background(), req)
}
