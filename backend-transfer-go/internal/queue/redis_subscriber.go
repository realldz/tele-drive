package queue

import (
	"context"
	"encoding/json"
	"log/slog"
	"strconv"
	"time"

	"github.com/redis/go-redis/v9"
	"github.com/realldz/tele-drive/backend-transfer-go/internal/telegram"
)

type DeleteReporter interface {
	ReportDeleteSuccess(ctx context.Context, fileID string) error
	ReportDeleteFailed(ctx context.Context, fileID string, reason string) error
}

type RedisSubscriber struct {
	redisClient    *redis.Client
	telegramClient *telegram.TelegramClient
	reporter       DeleteReporter
	logger         *slog.Logger
	ctx            context.Context
	cancel         context.CancelFunc
}

func NewRedisSubscriber(rdb *redis.Client, tg *telegram.TelegramClient, reporter DeleteReporter, logger *slog.Logger) *RedisSubscriber {
	ctx, cancel := context.WithCancel(context.Background())
	return &RedisSubscriber{
		redisClient:    rdb,
		telegramClient: tg,
		reporter:       reporter,
		logger:         logger,
		ctx:            ctx,
		cancel:         cancel,
	}
}

type EventMessage struct {
	Type    string          `json:"type"`
	Payload json.RawMessage `json:"payload"`
}

type DeletePayload struct {
	FileID             string   `json:"fileId"`
	TelegramMessageIDs []string `json:"telegramMessageIds"`
	BotID              int64    `json:"botId"`
}

func (s *RedisSubscriber) Start() {
	pubsub := s.redisClient.Subscribe(s.ctx, "file:events")

	s.logger.Info("Started Redis Pub/Sub subscriber on file:events")

	go func() {
		defer pubsub.Close()

		ch := pubsub.Channel()
		for {
			select {
			case <-s.ctx.Done():
				s.logger.Info("Stopping Redis subscriber")
				return
			case msg := <-ch:
				s.handleMessage(msg.Payload)
			}
		}
	}()
}

func (s *RedisSubscriber) Stop() {
	s.cancel()
}

func (s *RedisSubscriber) handleMessage(data string) {
	var event EventMessage
	if err := json.Unmarshal([]byte(data), &event); err != nil {
		s.logger.Error("Failed to parse event message", "error", err)
		return
	}

	if event.Type == "DELETE_FILE" {
		s.handleDeleteFile(event.Payload)
	}
}

func (s *RedisSubscriber) handleDeleteFile(payloadRaw json.RawMessage) {
	var payload DeletePayload
	if err := json.Unmarshal(payloadRaw, &payload); err != nil {
		s.logger.Error("Failed to parse DELETE_FILE payload", "error", err)
		return
	}

	s.logger.Info("Processing DELETE_FILE event", "fileId", payload.FileID, "messagesCount", len(payload.TelegramMessageIDs))

	success := true
	var lastErr error

	for _, msgIDStr := range payload.TelegramMessageIDs {
		msgID, err := strconv.Atoi(msgIDStr)
		if err != nil {
			continue
		}

		deleted := false
		for attempt := 0; attempt < 3; attempt++ {
			err = s.telegramClient.DeleteMessage(context.Background(), msgID, payload.BotID)
			if err == nil {
				deleted = true
				break
			}
			s.logger.Warn("Failed to delete Telegram message, retrying", "msgId", msgID, "attempt", attempt+1, "error", err)
			time.Sleep(time.Duration(1<<attempt) * time.Second)
		}

		if !deleted {
			success = false
			lastErr = err
		}
	}

	reportCtx, reportCancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer reportCancel()

	if success {
		err := s.reporter.ReportDeleteSuccess(reportCtx, payload.FileID)
		if err != nil {
			s.logger.Error("Failed to report delete success via gRPC", "fileId", payload.FileID, "error", err)
		}
	} else {
		reason := "unknown"
		if lastErr != nil {
			reason = lastErr.Error()
		}
		err := s.reporter.ReportDeleteFailed(reportCtx, payload.FileID, reason)
		if err != nil {
			s.logger.Error("Failed to report delete failure via gRPC", "fileId", payload.FileID, "error", err)
		}
	}
}
