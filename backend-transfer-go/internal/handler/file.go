package handler

import (
	"crypto/rand"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/labstack/echo/v4"
	"github.com/realldz/tele-drive/backend-transfer-go/internal/crypto"
	"github.com/realldz/tele-drive/backend-transfer-go/internal/db"
	"github.com/realldz/tele-drive/backend-transfer-go/internal/middleware"
	"github.com/realldz/tele-drive/backend-transfer-go/internal/queue"
	"github.com/realldz/tele-drive/backend-transfer-go/internal/storage"
	"github.com/realldz/tele-drive/backend-transfer-go/internal/telegram"
	"gorm.io/gorm"
)

type FileHandler struct {
	database       *db.DB
	telegramClient *telegram.TelegramClient
	cryptoEngine   *crypto.CryptoEngine
	tempStorage    *storage.TempStorage
	bullClient     *queue.BullMQClient
	settingsCache  *db.SettingsCache
	downloader     *telegram.Downloader
	jwtSecret      string
	maxChunkSize   int64

	mu             sync.Mutex
	activeUploads  map[string]int
}

func NewFileHandler(
	database *db.DB,
	telegramClient *telegram.TelegramClient,
	cryptoEngine *crypto.CryptoEngine,
	tempStorage *storage.TempStorage,
	bullClient *queue.BullMQClient,
	settingsCache *db.SettingsCache,
	downloader *telegram.Downloader,
	jwtSecret string,
	maxChunkSize int64,
) *FileHandler {
	return &FileHandler{
		database:       database,
		telegramClient: telegramClient,
		cryptoEngine:   cryptoEngine,
		tempStorage:    tempStorage,
		bullClient:     bullClient,
		settingsCache:  settingsCache,
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

func (h *FileHandler) GetConfig(c echo.Context) error {
	maxConcurrent := h.settingsCache.GetCachedSettingInt("MAX_CONCURRENT_CHUNKS", 3)

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
	h.database.Model(&db.FileRecord{}).Where("id IN ? AND \"userId\" = ?", ids, userID).Select("id, status").Find(&results)

	return c.JSON(http.StatusOK, results)
}

// ---------------------------------------------------------------------------
// Helpers & Internal checks
// ---------------------------------------------------------------------------

type countingWriter struct {
	w     io.Writer
	count int64
}

func (cw *countingWriter) Write(p []byte) (n int, err error) {
	n, err = cw.w.Write(p)
	cw.count += int64(n)
	return n, err
}

func (h *FileHandler) isDescendantOf(folderID string, ancestorID string) (bool, error) {
	currentID := &folderID
	for currentID != nil {
		if *currentID == ancestorID {
			return true, nil
		}
		var folder db.Folder
		err := h.database.Where("id = ?", *currentID).First(&folder).Error
		if err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return false, nil
			}
			return false, err
		}
		if folder.DeletedAt != nil {
			return false, nil
		}
		currentID = folder.ParentID
	}
	return false, nil
}

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
