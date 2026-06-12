package config

import (
	"log"
	"os"
	"strconv"
	"strings"

	"github.com/joho/godotenv"
)

type Config struct {
	Port                     int
	DatabaseURL              string
	TelegramBotToken         string
	TelegramChatID           string
	TelegramAPIRoot          string
	TelegramUploadBotTokens  []string
	TelegramSendRateLimit    int
	MaxChunkSize             int64
	JWTSecret                string
	MasterSecret             string
	LogDir                   string
	LogLevel                 string
	CorsOrigin               string
	RedisURL                 string
	UploadBufferDir          string
	NestJSGrpcURL            string
	GrpcPort                 int
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

	return &Config{
		Port:                    port,
		DatabaseURL:             getEnv("DATABASE_URL", ""),
		TelegramBotToken:        getEnv("TELEGRAM_BOT_TOKEN", ""),
		TelegramChatID:          getEnv("TELEGRAM_CHAT_ID", ""),
		TelegramAPIRoot:         getEnv("TELEGRAM_API_ROOT", ""),
		TelegramUploadBotTokens: uploadBots,
		TelegramSendRateLimit:   rateLimit,
		MaxChunkSize:            maxChunk,
		JWTSecret:               getEnv("JWT_SECRET", ""),
		MasterSecret:            masterSecret,
		LogDir:                  getEnv("LOG_DIR", ".logs"),
		LogLevel:                getEnv("LOG_LEVEL", "info"),
		CorsOrigin:              getEnv("CORS_ORIGIN", "*"),
		RedisURL:                getEnv("REDIS_URL", "redis://localhost:6379"),
		UploadBufferDir:         getEnv("UPLOAD_BUFFER_DIR", ".upload-buffer"),
		NestJSGrpcURL:           getEnv("NESTJS_GRPC_URL", "localhost:50051"),
		GrpcPort:                grpcPort,
	}
}

func getEnv(key, defaultVal string) string {
	if val, ok := os.LookupEnv(key); ok {
		return val
	}
	return defaultVal
}
