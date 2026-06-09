package s3

import (
	"github.com/labstack/echo/v4"
	"github.com/realldz/tele-drive/backend-transfer-go/internal/crypto"
	"github.com/realldz/tele-drive/backend-transfer-go/internal/db"
	"github.com/realldz/tele-drive/backend-transfer-go/internal/queue"
	"github.com/realldz/tele-drive/backend-transfer-go/internal/storage"
	"github.com/realldz/tele-drive/backend-transfer-go/internal/telegram"
)

type S3Controller struct {
	database           *db.DB
	s3Service          *S3Service
	s3Multipart        *S3MultipartService
	telegram           *telegram.TelegramClient
	cryptoEngine       *crypto.CryptoEngine
	tempStorage        *storage.TempStorage
	bullClient         *queue.BullMQClient
	settingsCache      *db.SettingsCache
	downloader         *telegram.Downloader
	authenticator      *S3Authenticator
}

func NewS3Controller(
	database *db.DB,
	s3Service *S3Service,
	s3Multipart *S3MultipartService,
	telegram *telegram.TelegramClient,
	cryptoEngine *crypto.CryptoEngine,
	tempStorage *storage.TempStorage,
	bullClient *queue.BullMQClient,
	settingsCache *db.SettingsCache,
	downloader *telegram.Downloader,
	authenticator *S3Authenticator,
) *S3Controller {
	return &S3Controller{
		database:           database,
		s3Service:          s3Service,
		s3Multipart:        s3Multipart,
		telegram:           telegram,
		cryptoEngine:       cryptoEngine,
		tempStorage:        tempStorage,
		bullClient:         bullClient,
		settingsCache:      settingsCache,
		downloader:         downloader,
		authenticator:      authenticator,
	}
}

func (s *S3Controller) RegisterRoutes(e *echo.Echo) {
	// Middlewares
	authMiddleware := S3AuthMiddleware(s.authenticator)
	publicMiddleware := S3PublicMiddleware(s.database, s.settingsCache)

	// S3 Group (SigV4 authenticated) - Register under both /s3 and /api/s3
	for _, prefix := range []string{"/s3", "/api/s3"} {
		s3Group := e.Group(prefix, authMiddleware)
		s3Group.GET("", s.ListBuckets)
		s3Group.PUT("/:bucket", s.CreateBucket)
		s3Group.HEAD("/:bucket", s.HeadBucket)
		s3Group.DELETE("/:bucket", s.DeleteBucket)
		s3Group.GET("/:bucket", s.ListObjects)
		s3Group.POST("/:bucket", s.HandleBucketPost)

		s3Group.PUT("/:bucket/*", s.HandlePut)
		s3Group.POST("/:bucket/*", s.HandlePost)
		s3Group.GET("/:bucket/*", s.HandleGet)
		s3Group.HEAD("/:bucket/*", s.HeadObject)
		s3Group.DELETE("/:bucket/*", s.HandleDelete)
	}

	// Public Access Group (unauthenticated path checks) - Register under both /public and /api/public
	for _, prefix := range []string{"/public", "/api/public"} {
		publicGroup := e.Group(prefix, publicMiddleware)
		publicGroup.GET("/:userId/:bucket", s.ListObjectsPublic)
		publicGroup.GET("/:userId/:bucket/*", s.HandleGetPublic)
		publicGroup.HEAD("/:userId/:bucket/*", s.HeadObjectPublic)
	}
}
