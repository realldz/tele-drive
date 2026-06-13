package handler

import (
	"bytes"
	"fmt"
	"io"
	"net/http"
	"strconv"

	"github.com/labstack/echo/v4"
	"github.com/realldz/tele-drive/backend-transfer-go/internal/queue"
)

func (h *FileHandler) UploadChunkWithToken(c echo.Context) error {
	token := c.QueryParam("token")
	if token == "" {
		return c.JSON(http.StatusUnauthorized, map[string]string{"message": "Missing token"})
	}

	fileID := c.Param("fileId")
	indexStr := c.Param("index")

	chunkIndex, err := strconv.Atoi(indexStr)
	if err != nil {
		return c.JSON(http.StatusBadRequest, map[string]string{"message": "Invalid chunk index"})
	}

	userID, err := h.verifyUploadToken(c, token, fileID, &chunkIndex)
	if err != nil {
		return c.JSON(http.StatusForbidden, map[string]string{"message": err.Error()})
	}

	// Concurrency limit
	h.mu.Lock()
	active := h.activeUploads[userID]
	maxConcurrent := 3
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

	// Fetch metadata via gRPC
	meta, err := h.grpcClient.GetFileMetadata(c.Request().Context(), fileID)
	if err != nil {
		return c.JSON(http.StatusNotFound, map[string]string{"message": "File metadata not found"})
	}

	if meta.UserId != userID {
		return c.JSON(http.StatusForbidden, map[string]string{"message": "Access denied"})
	}

	if meta.Status == "complete" {
		return c.JSON(http.StatusBadRequest, map[string]string{"message": "File upload already completed"})
	}

	if chunkIndex < 0 || chunkIndex >= int(meta.TotalChunks) {
		return c.JSON(http.StatusBadRequest, map[string]string{"message": fmt.Sprintf("Invalid chunk index: %d", chunkIndex)})
	}

	// Idempotency check
	for _, chunk := range meta.Chunks {
		if int(chunk.ChunkIndex) == chunkIndex && chunk.TelegramFileId != "" {
			return c.JSON(http.StatusOK, map[string]interface{}{
				"id":                fmt.Sprintf("%s-chunk-%d", fileID, chunkIndex),
				"fileId":            fileID,
				"chunkIndex":        chunkIndex,
				"size":              chunk.Size,
				"telegramFileId":    chunk.TelegramFileId,
				"telegramMessageId": chunk.TelegramMessageId,
				"botId":             chunk.BotId,
				"encryptionIv":      chunk.EncryptionIv,
				"etag":              chunk.Etag,
				"status":            "complete",
			})
		}
	}

	// Large chunk / unknown size: stream straight to Telegram (no RAM/disk buffer).
	contentLength := c.Request().ContentLength
	if contentLength > h.maxChunkSize {
		return c.JSON(http.StatusBadRequest, map[string]string{
			"message": fmt.Sprintf("Chunk size exceeds maximum allowed size (%d bytes)", h.maxChunkSize),
		})
	}
	if contentLength <= 0 || contentLength > h.maxBufferFileSize {
		return h.streamToTelegram(c, fileID, chunkIndex, contentLength, meta)
	}

	// Read raw binary body
	body, err := io.ReadAll(c.Request().Body)
	if err != nil {
		return c.JSON(http.StatusBadRequest, map[string]string{"message": "Failed to read request body"})
	}
	defer c.Request().Body.Close()
	size := int64(len(body))

	if size > h.maxChunkSize {
		return c.JSON(http.StatusBadRequest, map[string]string{
			"message": fmt.Sprintf("Chunk size exceeds maximum allowed size (%d bytes)", h.maxChunkSize),
		})
	}

	// Capacity check
	if !h.tempStorage.HasCapacity(2048) {
		return c.JSON(http.StatusServiceUnavailable, map[string]string{"message": "Upload buffer disk space limit reached"})
	}

	storageKey := fmt.Sprintf("chunk/%s/%d.tmp", fileID, chunkIndex)
	if _, err := h.tempStorage.Write(storageKey, bytes.NewReader(body)); err != nil {
		return err
	}

	// Enqueue to internal worker pool
	if err := h.workerPool.AddJob(queue.ChunkJob{
		ID:             generateUUID(),
		FileID:         fileID,
		ChunkIndex:     chunkIndex,
		Size:           int(size),
		TempStorageKey: storageKey,
		UserID:         userID,
		Attempt:        0,
		IsChunked:      true,
	}); err != nil {
		return c.JSON(http.StatusServiceUnavailable, map[string]string{
			"error":   "upload_buffer_full",
			"message": "Upload buffer is temporarily full, please retry",
		})
	}

	return c.JSON(http.StatusOK, map[string]interface{}{
		"status":     "buffered",
		"chunkIndex": chunkIndex,
	})
}

func (h *FileHandler) UploadChunk(c echo.Context) error {
	userID := c.Get("userId").(string)
	fileID := c.Param("fileId")
	indexStr := c.Param("index")

	chunkIndex, err := strconv.Atoi(indexStr)
	if err != nil {
		return c.JSON(http.StatusBadRequest, map[string]string{"message": "Invalid chunk index"})
	}

	// Concurrency limit (admin-dashboard MAX_CONCURRENT_CHUNKS, default 3)
	maxConcurrent := h.maxConcurrentChunks(c.Request().Context())
	h.mu.Lock()
	active := h.activeUploads[userID]
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

	// Fetch metadata via gRPC to validate the file record exists and is not complete
	meta, err := h.grpcClient.GetFileMetadata(c.Request().Context(), fileID)
	if err != nil {
		return c.JSON(http.StatusNotFound, map[string]string{"message": "File metadata not found"})
	}

	if meta.UserId != userID {
		return c.JSON(http.StatusForbidden, map[string]string{"message": "Access denied"})
	}

	if meta.Status == "complete" {
		return c.JSON(http.StatusBadRequest, map[string]string{"message": "File upload already completed"})
	}

	if chunkIndex < 0 || chunkIndex >= int(meta.TotalChunks) {
		return c.JSON(http.StatusBadRequest, map[string]string{"message": fmt.Sprintf("Invalid chunk index: %d", chunkIndex)})
	}

	// Idempotency check: check if this chunk has already been uploaded successfully
	for _, chunk := range meta.Chunks {
		if int(chunk.ChunkIndex) == chunkIndex && chunk.TelegramFileId != "" {
			return c.JSON(http.StatusOK, map[string]interface{}{
				"id":                fmt.Sprintf("%s-chunk-%d", fileID, chunkIndex),
				"fileId":            fileID,
				"chunkIndex":        chunkIndex,
				"size":              chunk.Size,
				"telegramFileId":    chunk.TelegramFileId,
				"telegramMessageId": chunk.TelegramMessageId,
				"botId":             chunk.BotId,
				"encryptionIv":      chunk.EncryptionIv,
				"etag":              chunk.Etag,
				"status":            "complete",
			})
		}
	}

	// Large chunk / unknown size: stream straight to Telegram (no RAM/disk buffer).
	contentLength := c.Request().ContentLength
	if contentLength > h.maxChunkSize {
		return c.JSON(http.StatusBadRequest, map[string]string{
			"message": fmt.Sprintf("Chunk size exceeds maximum allowed size (%d bytes)", h.maxChunkSize),
		})
	}
	if contentLength <= 0 || contentLength > h.maxBufferFileSize {
		return h.streamToTelegram(c, fileID, chunkIndex, contentLength, meta)
	}

	// Read raw binary body (no multipart)
	body, err := io.ReadAll(c.Request().Body)
	if err != nil {
		return c.JSON(http.StatusBadRequest, map[string]string{"message": "Failed to read request body"})
	}
	defer c.Request().Body.Close()
	size := int64(len(body))

	// Reject chunks exceeding max size
	if size > h.maxChunkSize {
		return c.JSON(http.StatusBadRequest, map[string]string{
			"message": fmt.Sprintf("Chunk size exceeds maximum allowed size (%d bytes)", h.maxChunkSize),
		})
	}

	// Capacity check (tempStorage has 80% disk check threshold based on 2048MB max size)
	if !h.tempStorage.HasCapacity(2048) {
		return c.JSON(http.StatusServiceUnavailable, map[string]string{"message": "Upload buffer disk space limit reached"})
	}

	storageKey := fmt.Sprintf("chunk/%s/%d.tmp", fileID, chunkIndex)
	if _, err := h.tempStorage.Write(storageKey, bytes.NewReader(body)); err != nil {
		return err
	}

	// Enqueue to internal worker pool instead of DB + BullMQ
	if err := h.workerPool.AddJob(queue.ChunkJob{
		ID:             generateUUID(),
		FileID:         fileID,
		ChunkIndex:     chunkIndex,
		Size:           int(size),
		TempStorageKey: storageKey,
		UserID:         userID,
		Attempt:        0,
		IsChunked:      true,
	}); err != nil {
		return c.JSON(http.StatusServiceUnavailable, map[string]string{
			"error":   "upload_buffer_full",
			"message": "Upload buffer is temporarily full, please retry",
		})
	}

	return c.JSON(http.StatusOK, map[string]interface{}{
		"status":     "buffered",
		"chunkIndex": chunkIndex,
	})
}
