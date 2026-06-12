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
	"github.com/realldz/tele-drive/backend-transfer-go/internal/crypto"
	"github.com/realldz/tele-drive/backend-transfer-go/internal/db"
	appGrpc "github.com/realldz/tele-drive/backend-transfer-go/internal/grpc"
	"github.com/realldz/tele-drive/backend-transfer-go/internal/handler"
	"github.com/realldz/tele-drive/backend-transfer-go/internal/logger"
	"github.com/realldz/tele-drive/backend-transfer-go/internal/queue"
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

	log.Info("Starting backend-transfer service in Go (Phase 2 redesign)")

	// 3. Connect to Redis (used for stream cookies / tokens / caching metadata)
	rdb, err := db.ConnectRedis(cfg.RedisURL)
	if err != nil {
		log.Error("Failed to connect to Redis", "error", err)
		panic(err)
	}
	defer rdb.Close()
	log.Info("Connected to Redis")

	// 4. Initialize temp storage
	tempStorage, err := storage.NewTempStorage(cfg.UploadBufferDir)
	if err != nil {
		log.Error("Failed to initialize TempStorage", "error", err)
		panic(err)
	}
	log.Info("Initialized TempStorage", "dir", cfg.UploadBufferDir)

	// 5. Initialize crypto engine
	cryptoEngine, err := crypto.NewCryptoEngine(cfg.MasterSecret)
	if err != nil {
		log.Error("Failed to initialize CryptoEngine", "error", err)
		panic(err)
	}

	// 6. Initialize Telegram Client
	tgClient := telegram.NewTelegramClient(
		cfg.TelegramAPIRoot,
		cfg.TelegramChatID,
		cfg.TelegramBotToken,
		rdb,
		cfg.TelegramSendRateLimit,
	)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// 7. Initialize gRPC client (calls NestJS Core API)
	coreClient, err := appGrpc.NewCoreClient(cfg.NestJSGrpcURL, log)
	if err != nil {
		log.Error("Failed to create gRPC client", "error", err)
		panic(err)
	}
	defer coreClient.Close()

	// Verify NestJS gRPC connection (non-blocking, log warning if unavailable)
	go func() {
		pingCtx, pingCancel := context.WithTimeout(ctx, 10*time.Second)
		defer pingCancel()
		if pong, err := coreClient.Ping(pingCtx); err != nil {
			log.Warn("NestJS gRPC not reachable at startup (will retry later)", "error", err)
		} else {
			log.Info("NestJS gRPC connection verified", "timestamp", pong.Timestamp)
		}
	}()

	// 8. Initialize Batch Reporter and Worker Pool for uploads
	batchReporter := queue.NewBatchReporter(coreClient, log, 1*time.Second, 10)
	defer batchReporter.Stop()

	uploadWorker := queue.NewUploadWorker(coreClient, batchReporter, tgClient, cryptoEngine, tempStorage, log)
	workerPool := queue.NewWorkerPool(cfg.WorkerPoolSize, uploadWorker, log)
	defer workerPool.Stop()
	log.Info("Initialized internal upload WorkerPool", "size", cfg.WorkerPoolSize)

	// 9. Start gRPC server (TransferService)
	transferServer := appGrpc.NewTransferServer(log, workerPool, batchReporter, coreClient)
	go func() {
		if err := appGrpc.StartGRPCServer(ctx, cfg.GrpcPort, transferServer, log); err != nil {
			log.Error("gRPC server failed", "error", err)
		}
	}()
	log.Info("gRPC server started", "port", cfg.GrpcPort)

	// Retry Telegram init with backoff (handles nginx DNS race in Docker)
	{
		var tgInitErr error
		for attempt := 0; attempt < 10; attempt++ {
			tgInitErr = tgClient.Init(ctx, cfg.TelegramUploadBotTokens)
			if tgInitErr == nil {
				break
			}
			log.Warn("TelegramClient init attempt failed, retrying...", "attempt", attempt+1, "error", tgInitErr)
			select {
			case <-ctx.Done():
				tgInitErr = ctx.Err()
			case <-time.After(time.Duration(2<<attempt) * time.Second):
			}
		}
		if tgInitErr != nil {
			log.Error("Failed to initialize TelegramClient after retries", "error", tgInitErr)
			panic(tgInitErr)
		}
	}
	log.Info("Initialized TelegramClient bot pool", "botCount", len(cfg.TelegramUploadBotTokens)+1)

	// 10. Initialize Downloader for I/O streaming
	downloader := telegram.NewDownloader(
		tgClient,
		cryptoEngine,
		tempStorage,
		rdb,
		log,
	)

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

	fileHandler := handler.NewFileHandler(
		coreClient,
		rdb,
		workerPool,
		tgClient,
		cryptoEngine,
		tempStorage,
		downloader,
		cfg.JWTSecret,
		cfg.MaxChunkSize,
	)
	fileHandler.RegisterRoutes(e)

	// Graceful shutdown listener
	quit := make(chan os.Signal, 1)
	signal.Notify(quit, os.Interrupt, syscall.SIGTERM)
	go func() {
		<-quit
		log.Info("Received shutdown signal. Stopping services...")
		cancel() // cancel workers context

		// shutdown Echo http server with timeout
		shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer shutdownCancel()
		if err := e.Shutdown(shutdownCtx); err != nil {
			log.Error("Echo server shutdown failed", "error", err)
		}

		// wait for workers to finish current jobs
		workerPool.WaitForCompletion(5 * time.Second)
		log.Info("Services stopped gracefully")
	}()

	// Start Echo Server
	addr := fmt.Sprintf(":%d", cfg.Port)
	log.Info("HTTP server starting", "addr", addr)
	if err := e.Start(addr); err != nil && err != http.ErrServerClosed {
		log.Error("HTTP server stopped unexpectedly", "error", err)
		panic(err)
	}
}
