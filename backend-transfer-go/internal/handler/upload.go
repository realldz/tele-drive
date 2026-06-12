package handler

import (
	"bytes"
	"fmt"
	"io"
	"net/http"

	"github.com/labstack/echo/v4"
	"github.com/realldz/tele-drive/backend-transfer-go/internal/queue"
)

func (h *FileHandler) Upload(c echo.Context) error {
	userID := c.Get("userId").(string)
	fileID := c.Param("fileId")

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

	// Read raw binary body (no multipart)
	body, err := io.ReadAll(c.Request().Body)
	if err != nil {
		return c.JSON(http.StatusBadRequest, map[string]string{"message": "Failed to read request body"})
	}
	defer c.Request().Body.Close()
	size := int64(len(body))

	// Capacity check (tempStorage has 80% disk check threshold based on 2048MB max size)
	if !h.tempStorage.HasCapacity(2048) {
		return c.JSON(http.StatusServiceUnavailable, map[string]string{"message": "Upload buffer disk space limit reached"})
	}

	storageKey := fmt.Sprintf("buf/%s.tmp", fileID)
	if _, err := h.tempStorage.Write(storageKey, bytes.NewReader(body)); err != nil {
		return err
	}

	// Enqueue to internal worker pool instead of Gorm DB + BullMQ
	h.workerPool.AddJob(queue.ChunkJob{
		ID:             generateUUID(),
		FileID:         fileID,
		ChunkIndex:     0,
		Size:           int(size),
		TempStorageKey: storageKey,
		UserID:         userID,
		Attempt:        0,
	})

	return c.JSON(http.StatusOK, map[string]interface{}{
		"status": "buffered",
	})
}

func (h *FileHandler) AbortUpload(c echo.Context) error {
	userID := c.Get("userId").(string)
	fileID := c.Param("fileId")

	meta, err := h.grpcClient.GetFileMetadata(c.Request().Context(), fileID)
	if err != nil {
		return c.JSON(http.StatusNotFound, map[string]string{"message": "File metadata not found"})
	}

	if meta.UserId != userID {
		return c.JSON(http.StatusForbidden, map[string]string{"message": "Access denied"})
	}

	// Clean up local temp storage buffer files
	if meta.IsChunked {
		for i := 0; i < int(meta.TotalChunks); i++ {
			storageKey := fmt.Sprintf("chunk/%s/%d.tmp", fileID, i)
			_ = h.tempStorage.Delete(storageKey)
		}
	} else {
		storageKey := fmt.Sprintf("buf/%s.tmp", fileID)
		_ = h.tempStorage.Delete(storageKey)
	}

	return c.JSON(http.StatusOK, map[string]bool{"success": true})
}

func (h *FileHandler) GetUploadStatus(c echo.Context) error {
	userID := c.Get("userId").(string)
	fileID := c.Param("fileId")

	meta, err := h.grpcClient.GetFileMetadata(c.Request().Context(), fileID)
	if err != nil {
		return c.JSON(http.StatusNotFound, map[string]string{"message": "File metadata not found"})
	}

	if meta.UserId != userID {
		return c.JSON(http.StatusForbidden, map[string]string{"message": "Access denied"})
	}

	type chunkStatus struct {
		ChunkIndex int  `json:"chunkIndex"`
		Uploaded   bool `json:"uploaded"`
	}
	var results []chunkStatus
	for _, chunk := range meta.Chunks {
		results = append(results, chunkStatus{
			ChunkIndex: int(chunk.ChunkIndex),
			Uploaded:   chunk.TelegramFileId != "",
		})
	}

	return c.JSON(http.StatusOK, results)
}
