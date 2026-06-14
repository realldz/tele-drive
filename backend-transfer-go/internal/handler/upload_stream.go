package handler

import (
	"context"
	"crypto/md5"
	"encoding/hex"
	"fmt"
	"io"
	"time"

	"github.com/labstack/echo/v4"
	pb "github.com/realldz/tele-drive/backend-transfer-go/internal/grpc/proto"
)

// streamCounter counts bytes flowing through and feeds an md5 hash.
type streamCounter struct {
	r     io.Reader
	hash  interface{ Write([]byte) (int, error) }
	count int64
}

func (s *streamCounter) Read(p []byte) (int, error) {
	n, err := s.r.Read(p)
	if n > 0 {
		s.count += int64(n)
		_, _ = s.hash.Write(p[:n])
	}
	return n, err
}

// streamToTelegram encrypts (if needed) and streams the request body straight
// to Telegram without buffering the whole file to RAM/disk. It then reports
// completion to NestJS via gRPC. Used for large files (> MaxBufferFileSize) and
// the S3 redirect path where holding the file in memory is not viable.
//
// chunkIndex < 0 means the upload is a standalone (non-chunked) file.
func (h *FileHandler) streamToTelegram(
	c echo.Context,
	fileID string,
	chunkIndex int,
	declaredSize int64,
	meta *pb.FileMetadata,
) error {
	ctx := c.Request().Context()

	var dek []byte
	if meta.IsEncrypted {
		var err error
		dek, err = h.cryptoEngine.DecryptKey(meta.EncryptedKey)
		if err != nil {
			return c.JSON(500, map[string]string{"message": "failed to decrypt file key"})
		}
	}

	ivBytes, _ := h.cryptoEngine.GenerateIv()

	body := c.Request().Body
	defer body.Close()

	hash := md5.New()
	counter := &streamCounter{r: body, hash: hash}

	var encStream io.Reader = counter
	if meta.IsEncrypted {
		var err error
		encStream, err = h.cryptoEngine.EncryptStream(counter, dek, ivBytes)
		if err != nil {
			return c.JSON(500, map[string]string{"message": "failed to init encryption"})
		}
	}

	var filename string
	if chunkIndex >= 0 {
		filename = fmt.Sprintf("%s.part%03d", fileID, chunkIndex)
	} else {
		filename = fileID
	}

	telegramFileID, telegramMessageID, botID, err := h.telegramClient.UploadFile(ctx, encStream, filename, declaredSize)
	if err != nil {
		h.logger.Error("Direct stream upload to Telegram failed", "fileId", fileID, "chunkIndex", chunkIndex, "error", err)
		return c.JSON(502, map[string]string{"message": "upload to storage backend failed"})
	}

	md5Hex := hex.EncodeToString(hash.Sum(nil))
	etag := fmt.Sprintf("\"%s\"", md5Hex)
	ivHex := hex.EncodeToString(ivBytes)

	if chunkIndex >= 0 {
		// Chunk completion → NestJS upserts FileChunk
		reportCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if _, err := h.grpcClient.ReportChunkResults(reportCtx, []*pb.ChunkResult{{
			FileId:            fileID,
			ChunkIndex:        int32(chunkIndex),
			TelegramFileId:    telegramFileID,
			TelegramMessageId: int32(telegramMessageID),
			BotId:             botID,
			EncryptionIv:      ivHex,
			Size:              int32(counter.count),
			Etag:              etag,
			ChunkId:           generateUUID(),
		}}); err != nil {
			h.logger.Error("Failed to report streamed chunk", "fileId", fileID, "chunkIndex", chunkIndex, "error", err)
			return c.JSON(500, map[string]string{"message": "failed to record chunk"})
		}

		h.logger.Info("Chunk streamed directly to Telegram", "fileId", fileID, "chunkIndex", chunkIndex, "size", counter.count)
		// S3 UploadPart clients read the ETag from the response header.
		c.Response().Header().Set("ETag", etag)
		return c.JSON(200, map[string]interface{}{
			"status":            "complete",
			"chunkIndex":        chunkIndex,
			"size":              counter.count,
			"telegramFileId":    telegramFileID,
			"telegramMessageId": telegramMessageID,
			"botId":             botID,
			"encryptionIv":      ivHex,
			"etag":              etag,
		})
	}

	// Non-chunked file completion → NestJS completes FileRecord
	reportCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := h.grpcClient.ReportFileComplete(reportCtx, &pb.ReportFileCompleteRequest{
		FileId:            fileID,
		TelegramFileId:    telegramFileID,
		TelegramMessageId: int32(telegramMessageID),
		BotId:             botID,
		EncryptionIv:      ivHex,
		Size:              counter.count,
		Etag:              etag,
	}); err != nil {
		h.logger.Error("Failed to report streamed file completion", "fileId", fileID, "error", err)
		return c.JSON(500, map[string]string{"message": "failed to record file"})
	}

	h.logger.Info("File streamed directly to Telegram", "fileId", fileID, "size", counter.count, "botId", botID)
	// S3 PutObject clients read the ETag from the response header.
	c.Response().Header().Set("ETag", etag)
	return c.JSON(200, map[string]interface{}{
		"status": "complete",
		"size":   counter.count,
		"etag":   etag,
	})
}
