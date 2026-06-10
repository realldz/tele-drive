package handler

import (
	"bytes"
	"crypto/md5"
	"encoding/hex"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strconv"
	"time"

	"github.com/labstack/echo/v4"
	"github.com/realldz/tele-drive/backend-transfer-go/internal/db"
)

func (h *FileHandler) UploadChunk(c echo.Context) error {
	userID := c.Get("userId").(string)
	fileID := c.Param("fileId")
	indexStr := c.Param("index")

	chunkIndex, err := strconv.Atoi(indexStr)
	if err != nil {
		return c.JSON(http.StatusBadRequest, map[string]string{"message": "Invalid chunk index"})
	}

	// Concurrency limit (unchanged)
	h.mu.Lock()
	active := h.activeUploads[userID]
	maxConcurrent := h.settingsCache.GetCachedSettingInt("MAX_CONCURRENT_CHUNKS", 3)
	if active >= maxConcurrent {
		h.mu.Unlock()
		c.Response().Header().Set("Retry-After", "5")
		return c.JSON(http.StatusTooManyRequests, map[string]interface{}{
			"message":    fmt.Sprintf("Too many concurrent uploads. Maximum %d chunks at a time.", maxConcurrent),
			"retryAfter": 5,
		})
	}
	h.activeUploads[userID] = active + 1
	h.mu.Unlock()

	defer func() {
		h.mu.Lock()
		h.activeUploads[userID] = h.activeUploads[userID] - 1
		if h.activeUploads[userID] <= 0 {
			delete(h.activeUploads, userID)
		}
		h.mu.Unlock()
	}()

	// Verify file record exists and belongs to user
	var fileRecord db.FileRecord
	if err := h.database.Where("id = ? AND \"userId\" = ?", fileID, userID).First(&fileRecord).Error; err != nil {
		return c.JSON(http.StatusNotFound, map[string]string{"message": "File record not found"})
	}
	if chunkIndex < 0 || chunkIndex >= fileRecord.TotalChunks {
		return c.JSON(http.StatusBadRequest, map[string]string{"message": fmt.Sprintf("Invalid chunk index: %d", chunkIndex)})
	}

	// Read raw binary body (no multipart)
	body, err := io.ReadAll(c.Request().Body)
	if err != nil {
		return c.JSON(http.StatusBadRequest, map[string]string{"message": "Failed to read request body"})
	}
	defer c.Request().Body.Close()
	size := int64(len(body))

	// Reject chunks exceeding max size (configurable via MAX_CHUNK_SIZE env)
	if size > h.maxChunkSize {
		return c.JSON(http.StatusBadRequest, map[string]string{
			"message": fmt.Sprintf("Chunk size exceeds maximum allowed size (%d bytes)", h.maxChunkSize),
		})
	}

	// Idempotency check
	var existing db.FileChunk
	err = h.database.Where("\"fileId\" = ? AND \"chunkIndex\" = ?", fileID, chunkIndex).First(&existing).Error
	if err == nil {
		if existing.TelegramFileID != nil && *existing.TelegramFileID != "" {
			return c.JSON(http.StatusOK, existing)
		}
		h.database.Delete(&existing)
	}

	// Buffer decision
	maxSize := h.settingsCache.GetCachedSettingInt64("MAX_BUFFER_FILE_SIZE", 52428800)
	capacityOk := size <= maxSize && h.tempStorage.HasCapacity(h.settingsCache)

	if capacityOk {
		storageKey := fmt.Sprintf("chunk/%s/%d.tmp", fileID, chunkIndex)
		hash := md5.New()
		counter := &countingWriter{w: hash}
		tee := io.TeeReader(bytes.NewReader(body), counter)

		if _, err := h.tempStorage.Write(storageKey, tee); err == nil {
			md5Hex := hex.EncodeToString(hash.Sum(nil))
			etag := fmt.Sprintf("\"%s\"", md5Hex)

			var encryptionIv *string
			if fileRecord.IsEncrypted && fileRecord.EncryptedKey != nil {
				ivBytes, _ := h.cryptoEngine.GenerateIv()
				ivStr := hex.EncodeToString(ivBytes)
				encryptionIv = &ivStr
			}

			chunk := db.FileChunk{
				ID:             generateUUID(),
				FileID:         fileID,
				ChunkIndex:     chunkIndex,
				Size:           int(counter.count),
				TempStorageKey: &storageKey,
				Status:         "buffered",
				EncryptionIv:   encryptionIv,
				Etag:           &etag,
				CreatedAt:      time.Now(),
			}

			if err := h.database.Create(&chunk).Error; err == nil {
				jobData := map[string]interface{}{
					"type":           "chunk",
					"chunkId":        chunk.ID,
					"fileRecordId":   fileID,
					"chunkIndex":     chunkIndex,
					"tempStorageKey": storageKey,
					"userId":         userID,
				}
				maxRetries := h.settingsCache.GetCachedSettingInt("BUFFER_MAX_RETRIES", 3)
				if err := h.bullClient.AddJob(c.Request().Context(), "upload-dispatch", "dispatch-chunk", fmt.Sprintf("chunk-%s", chunk.ID), jobData, maxRetries); err != nil {
					slog.Warn("AddJob failed for buffered chunk upload", "chunkId", chunk.ID, "fileId", fileID, "error", err)
				}
				return c.JSON(http.StatusOK, chunk)
			}
			_ = h.tempStorage.Delete(storageKey)
		}
	}

	// Direct upload path: encrypt → Telegram
	dek, err := h.cryptoEngine.DecryptKey(*fileRecord.EncryptedKey)
	if err != nil {
		return err
	}
	ivBytes, err := h.cryptoEngine.GenerateIv()
	if err != nil {
		return err
	}

	hash := md5.New()
	counter := &countingWriter{w: hash}
	tee := io.TeeReader(bytes.NewReader(body), counter)
	encryptedStream, err := h.cryptoEngine.EncryptStream(tee, dek, ivBytes)
	if err != nil {
		return err
	}

	chunkFilename := fmt.Sprintf("%s.part%03d", fileRecord.ID, chunkIndex)
	telegramFileID, telegramMessageID, botID, err := h.telegramClient.UploadFile(c.Request().Context(), encryptedStream, chunkFilename, size)
	if err != nil {
		return err
	}

	md5Hex := hex.EncodeToString(hash.Sum(nil))
	etag := fmt.Sprintf("\"%s\"", md5Hex)
	ivStr := hex.EncodeToString(ivBytes)

	chunk := db.FileChunk{
		ID:                generateUUID(),
		FileID:            fileID,
		ChunkIndex:        chunkIndex,
		Size:              int(counter.count),
		TelegramFileID:    &telegramFileID,
		TelegramMessageID: intAddr(telegramMessageID),
		BotID:             botID,
		EncryptionIv:      &ivStr,
		Etag:              &etag,
		Status:            "complete",
		CreatedAt:         time.Now(),
	}

	if err := h.database.Create(&chunk).Error; err != nil {
		_ = h.telegramClient.DeleteMessage(c.Request().Context(), telegramMessageID, botID)
		return err
	}

	return c.JSON(http.StatusOK, chunk)
}
