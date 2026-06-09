package main

import (
	"context"
	"fmt"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/labstack/echo/v4"
	echoMiddleware "github.com/labstack/echo/v4/middleware"
	"github.com/realldz/tele-drive/backend-transfer-go/internal/config"
	"github.com/realldz/tele-drive/backend-transfer-go/internal/cron"
	"github.com/realldz/tele-drive/backend-transfer-go/internal/crypto"
	"github.com/realldz/tele-drive/backend-transfer-go/internal/db"
	"github.com/realldz/tele-drive/backend-transfer-go/internal/handler"
	"github.com/realldz/tele-drive/backend-transfer-go/internal/logger"
	"github.com/realldz/tele-drive/backend-transfer-go/internal/queue"
	"github.com/realldz/tele-drive/backend-transfer-go/internal/s3"
	"github.com/realldz/tele-drive/backend-transfer-go/internal/storage"
	"github.com/realldz/tele-drive/backend-transfer-go/internal/telegram"
)

func main() {
	// 1. Load configuration
	cfg := config.Load()

	// 2. Initialize logger (Winston daily rotate JSON log compat)
	log, logCloser, err := logger.InitLogger(cfg.LogDir, cfg.LogLevel)
	if err != nil {
		panic(fmt.Sprintf("Failed to initialize logger: %v", err))
	}
	defer logCloser.Close()

	log.Info("Starting backend-transfer service in Go")

	// 3. Connect to database
	database, err := db.ConnectPostgres(cfg.DatabaseURL, cfg.LogLevel == "debug")
	if err != nil {
		log.Error("Failed to connect to PostgreSQL", "error", err)
		panic(err)
	}
	log.Info("Connected to PostgreSQL database")

	// 4. Connect to Redis
	rdb, err := db.ConnectRedis(cfg.RedisURL)
	if err != nil {
		log.Error("Failed to connect to Redis", "error", err)
		panic(err)
	}
	defer rdb.Close()
	log.Info("Connected to Redis")

	// 5. Initialize temp storage
	tempStorage, err := storage.NewTempStorage(cfg.UploadBufferDir)
	if err != nil {
		log.Error("Failed to initialize TempStorage", "error", err)
		panic(err)
	}
	log.Info("Initialized TempStorage", "dir", cfg.UploadBufferDir)

	// 6. Initialize settings cache
	settingsCache := db.NewSettingsCache(database)

	// 7. Initialize crypto engine
	cryptoEngine, err := crypto.NewCryptoEngine(cfg.MasterSecret)
	if err != nil {
		log.Error("Failed to initialize CryptoEngine", "error", err)
		panic(err)
	}

	s3Decryptor, err := crypto.NewS3Decryptor(cfg.MasterSecret)
	if err != nil {
		log.Error("Failed to initialize S3Decryptor", "error", err)
		panic(err)
	}

	// 8. Initialize Telegram Client & Downloader
	tgClient := telegram.NewTelegramClient(
		cfg.TelegramAPIRoot,
		cfg.TelegramChatID,
		cfg.TelegramBotToken,
		rdb,
		cfg.TelegramSendRateLimit,
	)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	err = tgClient.Init(ctx, cfg.TelegramUploadBotTokens)
	if err != nil {
		log.Error("Failed to initialize TelegramClient", "error", err)
		panic(err)
	}
	log.Info("Initialized TelegramClient bot pool", "botCount", len(cfg.TelegramUploadBotTokens)+1)

	downloader := telegram.NewDownloader(
		tgClient,
		cryptoEngine,
		tempStorage,
		database,
		settingsCache,
	)

	// 9. Start background BullMQ workers
	uploadWorker := queue.NewUploadWorker(database, tgClient, cryptoEngine, tempStorage, settingsCache, log)
	uploadBullWorker := queue.NewBullMQWorker(rdb, "upload-dispatch", uploadWorker.ProcessJob, log)
	uploadConcurrency := 1 + len(cfg.TelegramUploadBotTokens)
	uploadBullWorker.Start(ctx, uploadConcurrency)
	log.Info("Started upload-dispatch queue worker", "concurrency", uploadConcurrency)

	zipWorker := queue.NewZipWorker(database, tgClient, cryptoEngine, tempStorage, log)
	zipBullWorker := queue.NewBullMQWorker(rdb, "download-zip", zipWorker.ProcessJob, log)
	zipBullWorker.Start(ctx, 2)
	log.Info("Started download-zip queue worker", "concurrency", 2)

	// 10. Start background Cron cleanups
	cron.StartCronJobs(ctx, database, tgClient, tempStorage, settingsCache, log)
	log.Info("Started background cron cleanup routines")

	// 11. Set up Echo Web Server
	e := echo.New()
	e.HideBanner = true
	e.HidePort = true

	// Standard middlewares
	e.Use(echoMiddleware.Recover())
	e.Use(echoMiddleware.CORSWithConfig(echoMiddleware.CORSConfig{
		AllowOrigins:     []string{cfg.CorsOrigin},
		AllowMethods:     []string{http.MethodGet, http.MethodHead, http.MethodPut, http.MethodPatch, http.MethodPost, http.MethodDelete},
		AllowCredentials: true,
		ExposeHeaders:    []string{"X-Bandwidth-Reset", "X-Request-ID", "Content-Length", "Content-Range", "ETag"},
	}))

	// Register REST File routes
	bullMQClient := queue.NewBullMQClient(rdb)
	fileHandler := handler.NewFileHandler(
		database,
		tgClient,
		cryptoEngine,
		tempStorage,
		bullMQClient,
		settingsCache,
		downloader,
		cfg.JWTSecret,
	)
	fileHandler.RegisterRoutes(e)

	// Register S3 API routes
	s3Service := s3.NewS3Service(database, settingsCache)
	s3Multipart := s3.NewS3MultipartService(database, tgClient, cryptoEngine, s3Service, tempStorage, bullMQClient, settingsCache)
	s3Authenticator := s3.NewS3Authenticator(database, s3Decryptor)
	s3Controller := s3.NewS3Controller(
		database,
		s3Service,
		s3Multipart,
		tgClient,
		cryptoEngine,
		tempStorage,
		bullMQClient,
		settingsCache,
		downloader,
		s3Authenticator,
	)
	s3Controller.RegisterRoutes(e)

	// Graceful shutdown listener
	quit := make(chan os.Signal, 1)
	signal.Notify(quit, os.Interrupt, syscall.SIGTERM)
	go func() {
		<-quit
		log.Info("Received shutdown signal. Stopping services...")
		cancel() // cancel workers and cron context

		// shutdown Echo http server with timeout
		shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer shutdownCancel()
		if err := e.Shutdown(shutdownCtx); err != nil {
			log.Error("Echo server shutdown failed", "error", err)
		}
	}()

	// Start Echo Server
	addr := fmt.Sprintf(":%d", cfg.Port)
	log.Info("HTTP server starting", "addr", addr)
	if err := e.Start(addr); err != nil && err != http.ErrServerClosed {
		log.Error("HTTP server stopped unexpectedly", "error", err)
		panic(err)
	}
}
