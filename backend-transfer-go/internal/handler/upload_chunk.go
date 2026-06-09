package handler

import (
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

	// 1. Concurrency limit check
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

	file, err := c.FormFile("file")
	if err != nil {
		return c.JSON(http.StatusBadRequest, map[string]string{"message": "No file field in request"})
	}
	src, err := file.Open()
	if err != nil {
		return err
	}
	defer src.Close()

	size := file.Size

	var fileRecord db.FileRecord
	if err := h.database.Where("id = ? AND \"userId\" = ? AND \"deletedAt\" IS NULL", fileID, userID).First(&fileRecord).Error; err != nil {
		return c.JSON(http.StatusNotFound, map[string]string{"message": "File record not found"})
	}

	if fileRecord.Status != "uploading" {
		return c.JSON(http.StatusBadRequest, map[string]string{"message": "File upload already completed or aborted"})
	}

	if chunkIndex < 0 || chunkIndex >= fileRecord.TotalChunks {
		return c.JSON(http.StatusBadRequest, map[string]string{"message": fmt.Sprintf("Invalid chunk index: %d", chunkIndex)})
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

	capacityOk := false
	maxSize := h.settingsCache.GetCachedSettingInt64("MAX_BUFFER_FILE_SIZE", 52428800)
	if size <= maxSize {
		usedBytes, err := h.tempStorage.GetUsedBytes()
		if err == nil {
			maxDiskMb := h.settingsCache.GetCachedSettingInt64("MAX_BUFFER_DISK_MB", 2048)
			maxBytes := maxDiskMb * 1024 * 1024
			threshold := int64(float64(maxBytes) * 0.8)
			if usedBytes < threshold {
				capacityOk = true
			}
		}
	}

	if capacityOk {
		storageKey := fmt.Sprintf("chunk/%s/%d.tmp", fileID, chunkIndex)
		hash := md5.New()
		counter := &countingWriter{w: hash}
		tee := io.TeeReader(src, counter)

		_, err = h.tempStorage.Write(storageKey, tee)
		if err == nil {
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
				TelegramFileID: nil,
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

	// Direct upload path
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
	tee := io.TeeReader(src, counter)
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

	// Double check aborted
	var currentFile db.FileRecord
	if err := h.database.Where("id = ?", fileID).Select("status").First(&currentFile).Error; err == nil {
		if currentFile.Status == "aborted" {
			h.telegramClient.DeleteMessage(c.Request().Context(), telegramMessageID, botID)
			return c.JSON(http.StatusBadRequest, map[string]string{"message": "Upload aborted"})
		}
	}

	if err := h.database.Create(&chunk).Error; err != nil {
		_ = h.telegramClient.DeleteMessage(c.Request().Context(), telegramMessageID, botID)
		return err
	}

	return c.JSON(http.StatusOK, chunk)
}
