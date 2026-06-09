package handler

import (
	"bytes"
	"crypto/md5"
	"encoding/hex"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"time"

	"github.com/labstack/echo/v4"
	"github.com/realldz/tele-drive/backend-transfer-go/internal/db"
)

func (h *FileHandler) Upload(c echo.Context) error {
	userID := c.Get("userId").(string)
	fileID := c.Param("fileId")

	// Verify file record exists and belongs to user (created by NestJS InitUpload)
	var fileRecord db.FileRecord
	if err := h.database.Where("id = ? AND \"userId\" = ?", fileID, userID).First(&fileRecord).Error; err != nil {
		return c.JSON(http.StatusNotFound, map[string]string{"message": "File record not found"})
	}
	if fileRecord.Status == "complete" {
		return c.JSON(http.StatusBadRequest, map[string]string{"message": "File upload already completed"})
	}

	// Read raw binary body (no multipart)
	body, err := io.ReadAll(c.Request().Body)
	if err != nil {
		return c.JSON(http.StatusBadRequest, map[string]string{"message": "Failed to read request body"})
	}
	defer c.Request().Body.Close()
	size := int64(len(body))

	// Buffer decision (same capacity check, no quota check)
	maxSize := h.settingsCache.GetCachedSettingInt64("MAX_BUFFER_FILE_SIZE", 52428800)
	capacityOk := size <= maxSize && h.tempStorage.HasCapacity(h.settingsCache)

	if capacityOk {
		storageKey := fmt.Sprintf("buf/%s.tmp", fileID)
		if _, err := h.tempStorage.Write(storageKey, bytes.NewReader(body)); err == nil {
			// Mark FileRecord as buffered (status already "uploading" from NestJS)
			if err := h.database.Model(&db.FileRecord{}).Where("id = ?", fileID).Updates(map[string]interface{}{
				"tempStorageKey": &storageKey,
				"bufferRetries":  0,
				"updatedAt":      time.Now(),
			}).Error; err == nil {
				jobData := map[string]interface{}{
					"type":           "file",
					"recordId":       fileID,
					"tempStorageKey": storageKey,
					"userId":         userID,
				}
				maxRetries := h.settingsCache.GetCachedSettingInt("BUFFER_MAX_RETRIES", 3)
				if err := h.bullClient.AddJob(c.Request().Context(), "upload-dispatch", "dispatch-file", fmt.Sprintf("file-%s", fileID), jobData, maxRetries); err != nil {
					slog.Warn("AddJob failed for buffered file upload", "fileId", fileID, "error", err)
				}
				return c.JSON(http.StatusOK, map[string]interface{}{
					"status": "buffered",
				})
			}
			_ = h.tempStorage.Delete(storageKey)
		}
	}

	// Direct upload path: encrypt → Telegram
	dek, err := h.cryptoEngine.DecryptKey(*fileRecord.EncryptedKey)
	if err != nil {
		return err
	}
	iv, err := h.cryptoEngine.GenerateIv()
	if err != nil {
		return err
	}

	hash := md5.New()
	tee := io.TeeReader(bytes.NewReader(body), hash)
	encryptedStream, err := h.cryptoEngine.EncryptStream(tee, dek, iv)
	if err != nil {
		return err
	}

	telegramFileID, telegramMessageID, botID, err := h.telegramClient.UploadFile(c.Request().Context(), encryptedStream, fileRecord.Filename, size)
	if err != nil {
		return err
	}

	md5Hex := hex.EncodeToString(hash.Sum(nil))
	etag := fmt.Sprintf("\"%s\"", md5Hex)
	ivStr := hex.EncodeToString(iv)

	// Update FileRecord with Telegram IDs (no status change, no quota)
	if err := h.database.Model(&db.FileRecord{}).Where("id = ?", fileID).Updates(map[string]interface{}{
		"telegramFileId":    telegramFileID,
		"telegramMessageId": telegramMessageID,
		"botId":             botID,
		"encryptionIv":      ivStr,
		"etag":              etag,
	}).Error; err != nil {
		_ = h.telegramClient.DeleteMessage(c.Request().Context(), telegramMessageID, botID)
		return err
	}

	return c.JSON(http.StatusOK, map[string]interface{}{
		"telegramFileId":    telegramFileID,
		"telegramMessageId": telegramMessageID,
		"botId":             botID,
		"encryptionIv":      ivStr,
		"etag":              etag,
	})
}

func (h *FileHandler) AbortUpload(c echo.Context) error {
	userID := c.Get("userId").(string)
	fileID := c.Param("fileId")

	var fileRecord db.FileRecord
	err := h.database.Where("id = ? AND \"userId\" = ?", fileID, userID).First(&fileRecord).Error
	if err != nil {
		return c.JSON(http.StatusNotFound, map[string]string{"message": "File record not found"})
	}

	// Delete any Telegram messages that were already uploaded
	var chunks []db.FileChunk
	h.database.Where("\"fileId\" = ?", fileID).Find(&chunks)
	for _, chunk := range chunks {
		if chunk.TelegramMessageID != nil {
			_ = h.telegramClient.DeleteMessage(c.Request().Context(), *chunk.TelegramMessageID, chunk.BotID)
		}
	}
	if fileRecord.TelegramMessageID != nil {
		_ = h.telegramClient.DeleteMessage(c.Request().Context(), *fileRecord.TelegramMessageID, fileRecord.BotID)
	}

	// Delete record and chunks
	h.database.Where("\"fileId\" = ?", fileID).Delete(&db.FileChunk{})
	h.database.Delete(&fileRecord)

	return c.JSON(http.StatusOK, map[string]bool{"success": true})
}

func (h *FileHandler) GetUploadStatus(c echo.Context) error {
	userID := c.Get("userId").(string)
	fileID := c.Param("fileId")

	var fileRecord db.FileRecord
	if err := h.database.Where("id = ? AND \"userId\" = ?", fileID, userID).First(&fileRecord).Error; err != nil {
		return c.JSON(http.StatusNotFound, map[string]string{"message": "File record not found"})
	}

	var chunks []db.FileChunk
	if err := h.database.Where("\"fileId\" = ?", fileID).Order("\"chunkIndex\" ASC").Find(&chunks).Error; err != nil {
		// continue with empty results — best effort
	}

	type chunkStatus struct {
		ChunkIndex int  `json:"chunkIndex"`
		Uploaded   bool `json:"uploaded"`
	}
	var results []chunkStatus
	for _, c := range chunks {
		results = append(results, chunkStatus{
			ChunkIndex: c.ChunkIndex,
			Uploaded:   c.TelegramFileID != nil && *c.TelegramFileID != "",
		})
	}

	return c.JSON(http.StatusOK, results)
}
