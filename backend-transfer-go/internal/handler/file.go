package handler

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/labstack/echo/v4"
	"github.com/realldz/tele-drive/backend-transfer-go/internal/crypto"
	"github.com/realldz/tele-drive/backend-transfer-go/internal/grpc"
	"github.com/realldz/tele-drive/backend-transfer-go/internal/middleware"
	"github.com/realldz/tele-drive/backend-transfer-go/internal/queue"
	"github.com/realldz/tele-drive/backend-transfer-go/internal/s3auth"
	"github.com/realldz/tele-drive/backend-transfer-go/internal/settings"
	"github.com/realldz/tele-drive/backend-transfer-go/internal/storage"
	"github.com/realldz/tele-drive/backend-transfer-go/internal/telegram"
	"github.com/redis/go-redis/v9"
)

type FileHandler struct {
	grpcClient        *grpc.CoreClient
	redisClient       *redis.Client
	workerPool        *queue.WorkerPool
	telegramClient    *telegram.TelegramClient
	cryptoEngine      *crypto.CryptoEngine
	tempStorage       *storage.TempStorage
	downloader        *telegram.Downloader
	logger            *slog.Logger
	jwtSecret         string
	maxChunkSize      int64
	maxBufferFileSize int64
	// streamCookieSameSite is the configured SameSite mode ("strict"|"lax"|"none")
	// applied to every stream cookie. "none" enables cross-site delivery (app
	// domain → separate transfer domain); it always pairs with Secure.
	streamCookieSameSite string

	// settingsResolver pulls admin-dashboard SystemSetting values (TTL, concurrency,
	// multi-thread) over gRPC with a short TTL cache, so changes apply without redeploy.
	settingsResolver *settings.Resolver

	// s3Domain gates the S3 data-plane routes — requests are only treated as
	// S3 API calls when Host matches (set via S3_DOMAIN). Empty disables the filter.
	s3Domain string
	// s3Verifier validates AWS SigV4 on S3 data-plane requests (GET/HEAD/PUT),
	// resolving credentials Redis-first with gRPC fallback (Phase 3).
	s3Verifier *s3auth.Verifier

	mu            sync.Mutex
	activeUploads map[string]int
}

func NewFileHandler(
	grpcClient *grpc.CoreClient,
	redisClient *redis.Client,
	workerPool *queue.WorkerPool,
	telegramClient *telegram.TelegramClient,
	cryptoEngine *crypto.CryptoEngine,
	tempStorage *storage.TempStorage,
	downloader *telegram.Downloader,
	logger *slog.Logger,
	jwtSecret string,
	maxChunkSize int64,
	maxBufferFileSize int64,
	s3Domain string,
	settingsResolver *settings.Resolver,
	streamCookieSameSite string,
) *FileHandler {
	// Redis-first credential lookup with gRPC fallback (Phase 3), wrapped by the
	// SigV4 verifier (Phase 2). Built here so the verifier shares the handler's
	// redis + gRPC clients without extra wiring in main.go.
	credResolver := s3auth.NewCredentialResolver(redisClient, grpcClient, logger)
	s3Verifier := s3auth.New(credResolver, logger)

	return &FileHandler{
		grpcClient:        grpcClient,
		redisClient:       redisClient,
		workerPool:        workerPool,
		telegramClient:    telegramClient,
		cryptoEngine:      cryptoEngine,
		tempStorage:       tempStorage,
		downloader:        downloader,
		logger:            logger,
		jwtSecret:         jwtSecret,
		maxChunkSize:      maxChunkSize,
		maxBufferFileSize: maxBufferFileSize,
		settingsResolver:     settingsResolver,
		s3Domain:             s3Domain,
		s3Verifier:           s3Verifier,
		streamCookieSameSite: streamCookieSameSite,
		activeUploads:        make(map[string]int),
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
	files.GET("/stats", h.GetStats, authMiddleware)
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

	// ZIP part serving (Public). Create/status stay on NestJS (control plane);
	// only the binary part stream is Go-owned. Path mirrors the downloadUrl built
	// in NestJS getJobStatus: /transfer/download-zip/:id/file/:partIndex.
	files.GET("/download-zip/:id/file/:partIndex", h.ServeZipPart)

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
	maxConcurrent := h.maxConcurrentChunks(c.Request().Context())

	return c.JSON(http.StatusOK, map[string]interface{}{
		"maxChunkSize":        h.maxChunkSize,
		"maxConcurrentChunks": maxConcurrent,
	})
}

// maxConcurrentChunks resolves the admin-dashboard MAX_CONCURRENT_CHUNKS setting
// (default 3), shared by GetConfig and the per-user upload concurrency guard.
func (h *FileHandler) maxConcurrentChunks(ctx context.Context) int {
	if h.settingsResolver == nil {
		return 3
	}
	return h.settingsResolver.GetInt(ctx, "MAX_CONCURRENT_CHUNKS", 3)
}

// bufferFileSizeThreshold resolves the admin-dashboard MAX_BUFFER_FILE_SIZE
// setting: files/chunks at or below this stream-vs-buffer boundary are buffered
// to disk (retry + concurrency), larger ones stream straight to Telegram. Live
// from the resolver so dashboard edits take effect without a restart; falls back
// to the env-seeded static value when the resolver is unavailable.
func (h *FileHandler) bufferFileSizeThreshold(ctx context.Context) int64 {
	if h.settingsResolver == nil {
		return h.maxBufferFileSize
	}
	return h.settingsResolver.GetInt64(ctx, "MAX_BUFFER_FILE_SIZE", h.maxBufferFileSize)
}

// bufferDiskMb resolves the admin-dashboard MAX_BUFFER_DISK_MB setting (default
// 2048 = 2 GB), the max disk the upload buffer may occupy before new buffered
// writes are rejected. Live from the resolver so dashboard edits take effect
// without a restart; the capacity check applies an 80% threshold of this value
// (see TempStorage.HasCapacity).
func (h *FileHandler) bufferDiskMb(ctx context.Context) int64 {
	if h.settingsResolver == nil {
		return 2048
	}
	return h.settingsResolver.GetInt64(ctx, "MAX_BUFFER_DISK_MB", 2048)
}

// downloadURLTTL resolves the admin-dashboard DOWNLOAD_URL_TTL_SECONDS setting
// (default 300), the lifetime of a signed download token.
func (h *FileHandler) downloadURLTTL(ctx context.Context) int64 {
	if h.settingsResolver == nil {
		return 300
	}
	return h.settingsResolver.GetInt64(ctx, "DOWNLOAD_URL_TTL_SECONDS", 300)
}

// streamCookieTTL resolves the admin-dashboard STREAM_COOKIE_TTL_SECONDS setting
// (default 3600), the lifetime of a stream-auth cookie.
func (h *FileHandler) streamCookieTTL(ctx context.Context) int64 {
	if h.settingsResolver == nil {
		return 3600
	}
	return h.settingsResolver.GetInt64(ctx, "STREAM_COOKIE_TTL_SECONDS", 3600)
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

func (h *FileHandler) GetStats(c echo.Context) error {
	usedBytes, _ := h.tempStorage.GetUsedBytes()
	bufferCapacityBytes := h.bufferDiskMb(c.Request().Context()) * 1024 * 1024
	stats := map[string]interface{}{
		"workerPool": map[string]interface{}{
			"size":         h.workerPool.Size(),
			"activeJobs":   h.workerPool.ActiveCount(),
			"pendingQueue": h.workerPool.PendingCount(),
			"delayedQueue": h.workerPool.DelayedCount(),
		},
		"telegram": map[string]interface{}{
			"botCount":          h.telegramClient.BotCount(),
			"semaphoreUsed":     h.telegramClient.SemaphoreUsed(),
			"semaphoreCapacity": h.telegramClient.SemaphoreCapacity(),
		},
		"storage": map[string]interface{}{
			"bufferUsedBytes":     usedBytes,
			"bufferCapacityBytes": bufferCapacityBytes,
		},
		"grpc": map[string]interface{}{
			"coreConnected": h.grpcClient.IsConnected(),
		},
	}

	return c.JSON(http.StatusOK, stats)
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
