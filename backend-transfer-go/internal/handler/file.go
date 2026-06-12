package handler

import (
	"crypto/rand"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/labstack/echo/v4"
	"github.com/redis/go-redis/v9"
	"github.com/realldz/tele-drive/backend-transfer-go/internal/crypto"
	"github.com/realldz/tele-drive/backend-transfer-go/internal/grpc"
	"github.com/realldz/tele-drive/backend-transfer-go/internal/middleware"
	"github.com/realldz/tele-drive/backend-transfer-go/internal/queue"
	"github.com/realldz/tele-drive/backend-transfer-go/internal/storage"
	"github.com/realldz/tele-drive/backend-transfer-go/internal/telegram"
)

type FileHandler struct {
	grpcClient     *grpc.CoreClient
	redisClient    *redis.Client
	workerPool     *queue.WorkerPool
	telegramClient *telegram.TelegramClient
	cryptoEngine   *crypto.CryptoEngine
	tempStorage    *storage.TempStorage
	downloader     *telegram.Downloader
	jwtSecret      string
	maxChunkSize   int64

	mu             sync.Mutex
	activeUploads  map[string]int
}

func NewFileHandler(
	grpcClient *grpc.CoreClient,
	redisClient *redis.Client,
	workerPool *queue.WorkerPool,
	telegramClient *telegram.TelegramClient,
	cryptoEngine *crypto.CryptoEngine,
	tempStorage *storage.TempStorage,
	downloader *telegram.Downloader,
	jwtSecret string,
	maxChunkSize int64,
) *FileHandler {
	return &FileHandler{
		grpcClient:     grpcClient,
		redisClient:    redisClient,
		workerPool:     workerPool,
		telegramClient: telegramClient,
		cryptoEngine:   cryptoEngine,
		tempStorage:    tempStorage,
		downloader:     downloader,
		jwtSecret:      jwtSecret,
		maxChunkSize:   maxChunkSize,
		activeUploads:  make(map[string]int),
	}
}

func (h *FileHandler) RegisterRoutes(e *echo.Echo) {
	// Middleware setups
	authMiddleware := middleware.JWTMiddleware(h.jwtSecret)
	optAuthMiddleware := middleware.OptionalJWTMiddleware(h.jwtSecret)
	streamMiddleware := middleware.StreamCookieMiddleware(h.cryptoEngine)

	v1 := e.Group("/v1")
	files := v1.Group("/transfer")

	// Config (Public)
	files.GET("/config", h.GetConfig)
	// Healthcheck compat for Docker
	e.GET("/files/config", h.GetConfig)

	// Authenticated endpoints
	files.GET("/buffer-status", h.GetBufferStatus, authMiddleware)
	files.POST("/upload/:fileId", h.Upload, authMiddleware)
	files.POST("/upload/:fileId/chunk/:index", h.UploadChunk, authMiddleware)
	files.POST("/upload/:fileId/abort", h.AbortUpload, authMiddleware)
	files.GET("/upload/:fileId/status", h.GetUploadStatus, authMiddleware)
	files.POST("/:id/download-token", h.GenerateDownloadToken, authMiddleware)

	// Token-based upload endpoints (bypass JWT, rely on one-time S3 redirect token)
	files.PUT("/upload/:fileId", h.UploadWithToken)
	files.PUT("/upload/:fileId/chunk/:index", h.UploadChunkWithToken)

	// Stream Cookie endpoints
	files.POST("/stream-cookie", h.IssueStreamCookie, authMiddleware)
	files.POST("/stream-cookie/guest", h.IssueGuestStreamCookie, optAuthMiddleware)
	files.DELETE("/stream-cookie", h.ClearStreamCookie)

	// Stream/Download by token or cookie (Public)
	files.POST("/share/:token/download-token", h.GenerateShareDownloadToken, optAuthMiddleware)
	files.GET("/d/:token", h.DownloadBySigned)
	files.HEAD("/d/:token", h.CheckSignedToken)
	files.GET("/stream/:id", h.StreamByCookie, streamMiddleware)
	files.GET("/share/stream/:shareToken", h.StreamSharedByCookie, streamMiddleware)

	// Shared Folder download/stream routes (moved from Core)
	folders := v1.Group("/folders")
	folders.GET("/share/:token/download/:fileId", h.DownloadSharedFile)
	folders.GET("/share/:token/stream/:fileId", h.StreamSharedFolderFile)

	// Internal endpoints
	e.POST("/internal/files/purge", h.PurgeFiles)
}

func (h *FileHandler) verifyUploadToken(c echo.Context, token string, fileID string, expectedChunkIndex *int) (string, error) {
	tokenKey := "token:" + token
	tokenDataStr, err := h.redisClient.Get(c.Request().Context(), tokenKey).Result()
	if err != nil {
		return "", fmt.Errorf("invalid token")
	}

	var tokenData struct {
		FileID     string `json:"fileId"`
		UserID     string `json:"userId"`
		Type       string `json:"type"`
		ChunkIndex *int   `json:"chunkIndex"`
	}
	if err := json.Unmarshal([]byte(tokenDataStr), &tokenData); err != nil || tokenData.Type != "upload" {
		return "", fmt.Errorf("invalid token type")
	}

	if tokenData.FileID != fileID {
		return "", fmt.Errorf("token file ID mismatch")
	}

	if expectedChunkIndex != nil {
		if tokenData.ChunkIndex == nil || *tokenData.ChunkIndex != *expectedChunkIndex {
			return "", fmt.Errorf("token chunk index mismatch")
		}
	}

	// Consume token (one-time use)
	h.redisClient.Del(c.Request().Context(), tokenKey)
	return tokenData.UserID, nil
}

func (h *FileHandler) GetConfig(c echo.Context) error {
	maxConcurrent := 3

	return c.JSON(http.StatusOK, map[string]interface{}{
		"maxChunkSize":        h.maxChunkSize,
		"maxConcurrentChunks": maxConcurrent,
	})
}

func (h *FileHandler) GetBufferStatus(c echo.Context) error {
	userID := c.Get("userId").(string)
	idsStr := c.QueryParam("ids")
	if idsStr == "" {
		return c.JSON(http.StatusOK, []interface{}{})
	}

	parts := strings.Split(idsStr, ",")
	var ids []string
	for _, p := range parts {
		p = strings.TrimSpace(p)
		if p != "" {
			ids = append(ids, p)
		}
	}

	if len(ids) > 50 {
		ids = ids[:50]
	}

	type fileStatus struct {
		ID     string `json:"id"`
		Status string `json:"status"`
	}
	var results []fileStatus
	for _, id := range ids {
		meta, err := h.GetCachedMetadata(c.Request().Context(), id)
		if err == nil && meta.UserId == userID {
			results = append(results, fileStatus{
				ID:     meta.Id,
				Status: meta.Status,
			})
		}
	}

	return c.JSON(http.StatusOK, results)
}

// ---------------------------------------------------------------------------
// Helpers & Internal checks
// ---------------------------------------------------------------------------

func GenerateUniqueName(name string, existingNames []string) string {
	nameSet := make(map[string]bool)
	for _, n := range existingNames {
		nameSet[n] = true
	}

	if !nameSet[name] {
		return name
	}

	extIdx := strings.LastIndex(name, ".")
	base := name
	ext := ""
	if extIdx != -1 {
		base = name[:extIdx]
		ext = name[extIdx:]
	}

	counter := 1
	for {
		candidate := fmt.Sprintf("%s (%d)%s", base, counter, ext)
		if !nameSet[candidate] {
			return candidate
		}
		counter++
	}
}

func generateUUID() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:])
}

func stringAddr(s string) *string {
	return &s
}

func intAddr(i int) *int {
	return &i
}

func formatISO8601(t time.Time) string {
	return t.UTC().Format("2006-01-02T15:04:05.000Z")
}
