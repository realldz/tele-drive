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
	"github.com/realldz/tele-drive/backend-transfer-go/internal/settings"
	"github.com/realldz/tele-drive/backend-transfer-go/internal/storage"
	"github.com/realldz/tele-drive/backend-transfer-go/internal/telegram"
	"github.com/realldz/tele-drive/backend-transfer-go/internal/zip"
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

	// 7. Initialize gRPC client (calls NestJS Core API). When GRPC_TLS_* are set
	// the client presents this service's leaf cert and verifies NestJS against
	// the internal CA; ServerName "backend-core" must match the NestJS cert SAN
	// (the dns:/// authority it dials).
	coreClient, err := appGrpc.NewCoreClient(cfg.NestJSGrpcURL, appGrpc.CoreTLSConfig{
		CertFile:   cfg.GrpcTLSCert,
		KeyFile:    cfg.GrpcTLSKey,
		CAFile:     cfg.GrpcTLSCA,
		ServerName: "backend-core",
	}, log)
	if err != nil {
		log.Error("Failed to create gRPC client", "error", err)
		panic(err)
	}
	defer coreClient.Close()

	// Block until NestJS gRPC is ready (retry up to 60s)
	{
		ready := false
		for attempt := 0; attempt < 30; attempt++ {
			pingCtx, pingCancel := context.WithTimeout(ctx, 5*time.Second)
			pong, pingErr := coreClient.Ping(pingCtx)
			pingCancel()
			if pingErr == nil {
				log.Info("NestJS gRPC ready", "timestamp", pong.Timestamp)
				ready = true
				break
			}
			log.Warn("NestJS gRPC not ready, retrying...", "attempt", attempt+1, "error", pingErr)
			select {
			case <-ctx.Done():
				break
			case <-time.After(2 * time.Second):
			}
		}
		if !ready {
			log.Error("NestJS gRPC unreachable after 30 attempts", "error", "startup_timeout")
			panic("NestJS gRPC not reachable after 60s")
		}
	}

	// 8. Initialize Batch Reporter and Worker Pool for uploads
	// Tune the shared outstanding-counter TTL from config before any chunk enqueues.
	queue.SetOutstandingTTL(cfg.UploadOutstandingTTL)
	log.Info("Configured upload outstanding-counter TTL", "ttl", cfg.UploadOutstandingTTL)
	batchReporter := queue.NewBatchReporter(coreClient, tempStorage, rdb, log, 1*time.Second, 10)
	defer batchReporter.Stop()

	uploadWorker := queue.NewUploadWorker(coreClient, batchReporter, tgClient, cryptoEngine, tempStorage, log)
	workerPool := queue.NewWorkerPool(cfg.WorkerPoolSize, uploadWorker, rdb, log)
	defer workerPool.Stop()
	log.Info("Initialized internal upload WorkerPool", "size", cfg.WorkerPoolSize)

	// 9. Start gRPC server (TransferService)
	transferServer := appGrpc.NewTransferServer(log, workerPool, batchReporter, coreClient)
	go func() {
		if err := appGrpc.StartGRPCServer(ctx, cfg.GrpcPort, transferServer, cfg.GrpcTLSCert, cfg.GrpcTLSKey, cfg.GrpcTLSCA, log); err != nil {
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

	// 10b. Initialize Downloader for I/O streaming. The QuotaResolver enforces
	// the three bandwidth tiers (user/guest daily + per-file) cache-aside: Redis
	// first, gRPC GetBandwidthQuota on miss. coreClient satisfies quotaFetcher.
	quotaResolver := telegram.NewQuotaResolver(rdb, coreClient, log)
	// SettingsResolver pulls admin-dashboard SystemSetting values over gRPC with a
	// short TTL cache, so runtime config (TTLs, concurrency, multi-thread) applies
	// without a Go redeploy. Shared by the downloader and the file handler.
	settingsResolver := settings.NewResolver(coreClient, log)
	downloader := telegram.NewDownloader(
		tgClient,
		cryptoEngine,
		tempStorage,
		rdb,
		log,
		cfg.BandwidthCheckEnabled,
		batchReporter,
		quotaResolver,
		settingsResolver,
	)

	// 10c. Initialize ZIP worker (Go-owned archive assembly)
	zipWorker := zip.NewWorker(coreClient, downloader, tempStorage, log)

	// 10d. Start Redis Stream consumer for async delete + ZIP events. Consumer
	// group ensures each event is handled by exactly one Go instance (horizontal
	// scaling); per-instance ConsumerName lets XAUTOCLAIM reclaim a dead instance's
	// pending entries.
	redisSubscriber := queue.NewRedisSubscriber(rdb, tgClient, coreClient, zipWorker, queue.SubscriberConfig{
		Group:        cfg.EventConsumerGroup,
		ConsumerName: cfg.EventConsumerName,
		PoolSize:     cfg.EventWorkerPoolSize,
		ClaimMinIdle: cfg.EventClaimMinIdle,
	}, log)

	redisSubscriber.Start()
	defer redisSubscriber.Stop()

	// 11. Set up Echo Web Server
	e := echo.New()
	e.HideBanner = true
	e.HidePort = true

	// Map a bandwidth-quota rejection to a JSON 429 for web download/stream
	// callers (S3 handlers map it to XML themselves before returning). Centralized
	// here so every download.go caller surfaces the same shape the frontend parses
	// (api.ts), without each handler repeating the mapping. Other errors fall
	// through to Echo's default handler.
	defaultErrorHandler := e.HTTPErrorHandler
	e.HTTPErrorHandler = func(err error, c echo.Context) {
		if ble, ok := telegram.AsBandwidthLimitError(err); ok {
			if c.Response().Committed {
				return
			}
			if ble.ResetAt != "" {
				c.Response().Header().Set("X-Bandwidth-Reset", ble.ResetAt)
			}
			_ = c.JSON(http.StatusTooManyRequests, map[string]string{
				"code":    ble.Code,
				"resetAt": ble.ResetAt,
			})
			return
		}
		defaultErrorHandler(err, c)
	}

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
		log,
		cfg.JWTSecret,
		cfg.MaxChunkSize,
		cfg.MaxBufferFileSize,
		cfg.S3Domain,
		settingsResolver,
	)
	fileHandler.RegisterRoutes(e)
	// S3 data-plane routes (GET object) — mounted at root, gated by S3 host filter.
	fileHandler.RegisterS3Routes(e)

	// Graceful shutdown listener
	quit := make(chan os.Signal, 1)
	signal.Notify(quit, os.Interrupt, syscall.SIGTERM)

	// Start Echo Server
	addr := fmt.Sprintf(":%d", cfg.Port)
	log.Info("HTTP server starting", "addr", addr)
	go func() {
		if err := e.Start(addr); err != nil && err != http.ErrServerClosed {
			log.Error("HTTP server stopped unexpectedly", "error", err)
			panic(err)
		}
	}()

	<-quit
	log.Info("Shutdown signal received. Starting graceful shutdown sequence...")

	// Stop accepting new requests
	shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer shutdownCancel()
	if err := e.Shutdown(shutdownCtx); err != nil {
		log.Error("Echo server shutdown error", "error", err)
	}
	log.Info("1. HTTP server stopped (rejecting new requests)")

	// Tell workers to stop accepting new internal jobs
	cancel()

	// Wait for active workers to finish their current chunk
	log.Info("2. Waiting for active workers to finish (max 30s)...")
	workerPool.WaitForCompletion(30 * time.Second)

	// Flush any pending results to NestJS
	log.Info("3. Flushing pending gRPC results...")
	batchReporter.Stop()

	// Close connections
	log.Info("4. Closing connections...")
	coreClient.Close()

	log.Info("Graceful shutdown complete")
}
