package queue

import (
	"context"
	"crypto/md5"
	"encoding/hex"
	"fmt"
	"io"
	"log/slog"
	"time"

	"github.com/realldz/tele-drive/backend-transfer-go/internal/crypto"
	pb "github.com/realldz/tele-drive/backend-transfer-go/internal/grpc/proto"
	"github.com/realldz/tele-drive/backend-transfer-go/internal/storage"
	"github.com/realldz/tele-drive/backend-transfer-go/internal/telegram"
)

type CoreClient interface {
	ReportChunkResults(ctx context.Context, results []*pb.ChunkResult) (int32, error)
	ReportFileComplete(ctx context.Context, req *pb.ReportFileCompleteRequest) error
	GetFileMetadata(ctx context.Context, fileID string) (*pb.FileMetadata, error)
	ReportUploadFailed(ctx context.Context, req *pb.ReportUploadFailedRequest) error
	ReportBandwidthUsage(ctx context.Context, entries []*pb.BandwidthUsageEntry) error
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
	// Cleanup temp file on return. For a chunked job that succeeds, ownership of
	// the temp file is handed to the BatchReporter, which deletes it only after
	// the completion report is durably flushed to NestJS — so a still-draining
	// chunk stays downloadable from disk until its row flips to complete. In every
	// other case (failure, or non-chunked success that reports synchronously) we
	// delete here as before.
	handedOff := false
	defer func() {
		if !handedOff && job.TempStorageKey != "" {
			_ = uw.tempStorage.Delete(job.TempStorageKey)
		}
	}()

	// Fetch metadata via gRPC instead of DB
	meta, err := uw.grpcClient.GetFileMetadata(ctx, job.FileID)
	if err != nil {
		return err
	}

	var dek []byte
	if meta.IsEncrypted {
		dek, err = uw.cryptoEngine.DecryptKey(meta.EncryptedKey)
		if err != nil {
			return err
		}
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
	etag := fmt.Sprintf("\"%s\"", md5Hex)

	if job.IsChunked {
		// Chunk path: report via batcher (NestJS upserts FileChunk). Hand the temp
		// file to the reporter — it deletes it only after the completion report is
		// durably flushed, keeping the chunk downloadable from disk until then.
		uw.batchReporter.Report(&pb.ChunkResult{
			FileId:            job.FileID,
			ChunkIndex:        int32(job.ChunkIndex),
			TelegramFileId:    telegramFileID,
			TelegramMessageId: int32(telegramMessageID),
			BotId:             botID,
			EncryptionIv:      hex.EncodeToString(ivBytes),
			Size:              int32(counter.count),
			Etag:              etag,
			ChunkId:           job.ID,
		}, job.TempStorageKey)
		handedOff = true
		uw.logger.Info("Chunk dispatched via gRPC", "chunkIndex", job.ChunkIndex, "fileId", job.FileID)
		return nil
	}

	// Non-chunked file path: report record-level completion (NestJS completes FileRecord)
	reportCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := uw.grpcClient.ReportFileComplete(reportCtx, &pb.ReportFileCompleteRequest{
		FileId:            job.FileID,
		TelegramFileId:    telegramFileID,
		TelegramMessageId: int32(telegramMessageID),
		BotId:             botID,
		EncryptionIv:      hex.EncodeToString(ivBytes),
		Size:              counter.count,
		Etag:              etag,
	}); err != nil {
		return err
	}

	uw.logger.Info("File dispatched via gRPC", "fileId", job.FileID, "botId", botID)

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
