package config

import (
	"fmt"
	"log"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/joho/godotenv"
)

type Config struct {
	Port                     int
	WorkerPoolSize           int
	BandwidthCheckEnabled    bool
	TelegramBotToken         string
	TelegramChatID           string
	TelegramAPIRoot          string
	TelegramUploadBotTokens  []string
	TelegramSendRateLimit    int
	MaxChunkSize             int64
	MaxBufferFileSize        int64
	JWTSecret                string
	MasterSecret             string
	LogDir                   string
	LogLevel                 string
	CorsOrigin               string
	RedisURL                 string
	UploadBufferDir          string
	NestJSGrpcURL            string
	GrpcPort                 int
	S3Domain                 string
	// gRPC mTLS material. When all three are set, both the TransferService
	// server and the CoreService client run over TLS with mutual cert auth
	// (peers must present a cert signed by GrpcTLSCA). Empty → plaintext
	// (single-host bridge / local dev). SAN of each leaf must match the
	// dns:/// authority the peer dials (backend-core / backend-transfer).
	GrpcTLSCert string
	GrpcTLSKey  string
	GrpcTLSCA   string
	// Event stream (file:events) consumer-group settings. Multiple Go instances
	// join EventConsumerGroup so each event is delivered to exactly one instance
	// (vs the old Pub/Sub fan-out that delivered to all). EventConsumerName is the
	// per-instance identity used by XAUTOCLAIM to reclaim a dead instance's
	// pending entries; it MUST be unique per instance.
	EventConsumerGroup   string
	EventConsumerName    string
	EventWorkerPoolSize  int
	EventClaimMinIdle    time.Duration
}

func Load() *Config {
	// Optional: load .env file if it exists (useful for local development)
	_ = godotenv.Load()

	portStr := getEnv("PORT", "3001")
	port, err := strconv.Atoi(portStr)
	if err != nil {
		port = 3001
	}

	grpcPortStr := getEnv("GRPC_PORT", "50051")
	grpcPort, err := strconv.Atoi(grpcPortStr)
	if err != nil {
		grpcPort = 50051
	}

	rateLimitStr := getEnv("TELEGRAM_SEND_RATE_LIMIT", "18")
	rateLimit, err := strconv.Atoi(rateLimitStr)
	if err != nil {
		rateLimit = 18
	}

	maxChunkStr := getEnv("MAX_CHUNK_SIZE", "94371840")
	maxChunk, err := strconv.ParseInt(maxChunkStr, 10, 64)
	if err != nil {
		maxChunk = 94371840
	}

	// Files at or below this size are buffered to disk first (enables retry +
	// concurrency); larger files are streamed straight to Telegram to avoid
	// exhausting RAM/disk. Mirrors NestJS MAX_BUFFER_FILE_SIZE (default 50MB).
	maxBufferFileStr := getEnv("MAX_BUFFER_FILE_SIZE", "52428800")
	maxBufferFile, err := strconv.ParseInt(maxBufferFileStr, 10, 64)
	if err != nil {
		maxBufferFile = 52428800
	}

	workerPoolSizeStr := getEnv("WORKER_POOL_SIZE", "5")
	workerPoolSize, err := strconv.Atoi(workerPoolSizeStr)
	if err != nil {
		workerPoolSize = 5
	}

	bandwidthCheckEnabled := getEnv("BANDWIDTH_CHECK_ENABLED", "true") == "true"

	uploadBotsStr := getEnv("TELEGRAM_UPLOAD_BOT_TOKENS", "")
	var uploadBots []string
	if uploadBotsStr != "" {
		parts := strings.Split(uploadBotsStr, ",")
		for _, part := range parts {
			part = strings.TrimSpace(part)
			if part != "" {
				uploadBots = append(uploadBots, part)
			}
		}
	}

	masterSecret := getEnv("MASTER_SECRET", "")
	if len(masterSecret) > 0 && len(masterSecret) != 32 {
		log.Printf("Warning: MASTER_SECRET is %d bytes, expected exactly 32 bytes", len(masterSecret))
	}

	eventWorkerPoolSizeStr := getEnv("EVENT_WORKER_POOL_SIZE", "5")
	eventWorkerPoolSize, err := strconv.Atoi(eventWorkerPoolSizeStr)
	if err != nil || eventWorkerPoolSize <= 0 {
		eventWorkerPoolSize = 5
	}

	// Idle threshold before XAUTOCLAIM reclaims another instance's pending entry.
	// Must exceed the longest expected handler runtime so a slow-but-alive instance
	// is not robbed of its in-flight message.
	claimMinIdleStr := getEnv("EVENT_CLAIM_MIN_IDLE", "5m")
	claimMinIdle, err := time.ParseDuration(claimMinIdleStr)
	if err != nil || claimMinIdle <= 0 {
		claimMinIdle = 5 * time.Minute
	}

	// Per-instance consumer name for XAUTOCLAIM. Defaults to hostname-pid; override
	// with INSTANCE_ID when hostnames are not unique (e.g. some orchestrators).
	consumerName := getEnv("INSTANCE_ID", "")
	if consumerName == "" {
		host, hErr := os.Hostname()
		if hErr != nil || host == "" {
			host = "unknown"
		}
		consumerName = fmt.Sprintf("%s-%d", host, os.Getpid())
	}

	return &Config{
		Port:                    port,
		WorkerPoolSize:          workerPoolSize,
		BandwidthCheckEnabled:   bandwidthCheckEnabled,
		TelegramBotToken:        getEnv("TELEGRAM_BOT_TOKEN", ""),
		TelegramChatID:          getEnv("TELEGRAM_CHAT_ID", ""),
		TelegramAPIRoot:         getEnv("TELEGRAM_API_ROOT", ""),
		TelegramUploadBotTokens: uploadBots,
		TelegramSendRateLimit:   rateLimit,
		MaxChunkSize:            maxChunk,
		MaxBufferFileSize:       maxBufferFile,
		JWTSecret:               getEnv("JWT_SECRET", ""),
		MasterSecret:            masterSecret,
		LogDir:                  getEnv("LOG_DIR", ".logs"),
		LogLevel:                getEnv("LOG_LEVEL", "info"),
		CorsOrigin:              getEnv("CORS_ORIGIN", "*"),
		RedisURL:                getEnv("REDIS_URL", "redis://localhost:6379"),
		UploadBufferDir:         getEnv("UPLOAD_BUFFER_DIR", ".upload-buffer"),
		NestJSGrpcURL:           getEnv("NESTJS_GRPC_URL", "localhost:50051"),
		GrpcPort:                grpcPort,
		S3Domain:                getEnv("S3_DOMAIN", "s3.example.com"),
		GrpcTLSCert:             getEnv("GRPC_TLS_CERT", ""),
		GrpcTLSKey:              getEnv("GRPC_TLS_KEY", ""),
		GrpcTLSCA:               getEnv("GRPC_TLS_CA", ""),
		EventConsumerGroup:      getEnv("EVENT_CONSUMER_GROUP", "transfer-workers"),
		EventConsumerName:       consumerName,
		EventWorkerPoolSize:     eventWorkerPoolSize,
		EventClaimMinIdle:       claimMinIdle,
	}
}

func getEnv(key, defaultVal string) string {
	if val, ok := os.LookupEnv(key); ok {
		return val
	}
	return defaultVal
}
