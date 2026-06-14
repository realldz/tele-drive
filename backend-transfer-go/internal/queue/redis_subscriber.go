package queue

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/redis/go-redis/v9"
	"github.com/realldz/tele-drive/backend-transfer-go/internal/telegram"
)

// eventStreamKey is the Redis Stream that carries file:events. It replaces the
// former Pub/Sub channel of the same name: with a consumer group, each event is
// delivered to exactly ONE instance in the group (vs Pub/Sub fan-out to all),
// which is required to scale the Go transfer service horizontally without
// duplicate ZIP assembly / duplicate Telegram deletes.
const eventStreamKey = "file:events"

type DeleteReporter interface {
	ReportDeleteSuccess(ctx context.Context, fileID string) error
	ReportDeleteFailed(ctx context.Context, fileID string, reason string) error
}

// ZipProcessor handles CREATE_ZIP events by assembling a ZIP archive.
type ZipProcessor interface {
	Process(jobID string)
}

// SubscriberConfig holds consumer-group settings (sourced from config.Config).
type SubscriberConfig struct {
	Group        string        // consumer group name shared by all instances
	ConsumerName string        // per-instance identity, unique; used by XAUTOCLAIM
	PoolSize     int           // concurrent event handlers
	ClaimMinIdle time.Duration // idle threshold before reclaiming a dead instance's pending entry
}

type RedisSubscriber struct {
	redisClient    *redis.Client
	telegramClient *telegram.TelegramClient
	reporter       DeleteReporter
	zipProcessor   ZipProcessor
	logger         *slog.Logger
	cfg            SubscriberConfig
	ctx            context.Context
	cancel         context.CancelFunc
	jobs           chan redis.XMessage
	producerWg     sync.WaitGroup // reader + claimer goroutines
	workerWg       sync.WaitGroup // handler worker pool
}

func NewRedisSubscriber(rdb *redis.Client, tg *telegram.TelegramClient, reporter DeleteReporter, zipProcessor ZipProcessor, cfg SubscriberConfig, logger *slog.Logger) *RedisSubscriber {
	ctx, cancel := context.WithCancel(context.Background())
	if cfg.PoolSize <= 0 {
		cfg.PoolSize = 5
	}
	if cfg.Group == "" {
		cfg.Group = "transfer-workers"
	}
	if cfg.ClaimMinIdle <= 0 {
		cfg.ClaimMinIdle = 5 * time.Minute
	}
	return &RedisSubscriber{
		redisClient:    rdb,
		telegramClient: tg,
		reporter:       reporter,
		zipProcessor:   zipProcessor,
		logger:         logger,
		cfg:            cfg,
		ctx:            ctx,
		cancel:         cancel,
		jobs:           make(chan redis.XMessage, cfg.PoolSize*2),
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

type CreateZipPayload struct {
	JobID string `json:"jobId"`
}

func (s *RedisSubscriber) Start() {
	if err := s.ensureGroup(); err != nil {
		// Without the group, XReadGroup will fail every cycle. Log loudly; reads
		// will surface the same NOGROUP error so the operator sees it repeatedly.
		s.logger.Error("Failed to create consumer group; consumer may not receive events", "group", s.cfg.Group, "error", err)
	}

	s.logger.Info("Started Redis Stream consumer",
		"stream", eventStreamKey,
		"group", s.cfg.Group,
		"consumer", s.cfg.ConsumerName,
		"poolSize", s.cfg.PoolSize,
	)

	for i := 0; i < s.cfg.PoolSize; i++ {
		s.workerWg.Add(1)
		go s.worker(i)
	}

	s.producerWg.Add(2)
	go s.readLoop()
	go s.claimLoop()
}

// Stop drains cleanly: stop producing (reader + claimer), close the job channel,
// then wait for in-flight handlers to finish and ack. Fixes the old race where
// Stop() returned before the goroutine exited.
func (s *RedisSubscriber) Stop() {
	s.cancel()
	s.producerWg.Wait()
	close(s.jobs)
	s.workerWg.Wait()
	s.logger.Info("Redis Stream consumer stopped")
}

// ensureGroup creates the consumer group (and the stream itself via MKSTREAM) at
// the current tail ("$"). BUSYGROUP means it already exists — idempotent, ignore.
func (s *RedisSubscriber) ensureGroup() error {
	err := s.redisClient.XGroupCreateMkStream(s.ctx, eventStreamKey, s.cfg.Group, "$").Err()
	if err != nil && !strings.Contains(err.Error(), "BUSYGROUP") {
		return err
	}
	return nil
}

// readLoop pulls new (never-delivered) messages and feeds the worker pool.
func (s *RedisSubscriber) readLoop() {
	defer s.producerWg.Done()
	for {
		if s.ctx.Err() != nil {
			return
		}
		res, err := s.redisClient.XReadGroup(s.ctx, &redis.XReadGroupArgs{
			Group:    s.cfg.Group,
			Consumer: s.cfg.ConsumerName,
			Streams:  []string{eventStreamKey, ">"},
			Count:    int64(s.cfg.PoolSize),
			Block:    5 * time.Second,
		}).Result()
		if err != nil {
			if s.ctx.Err() != nil {
				return
			}
			// redis.Nil = BLOCK window elapsed with no new messages; just loop.
			if errors.Is(err, redis.Nil) {
				continue
			}
			s.logger.Error("XReadGroup failed", "error", err)
			select {
			case <-s.ctx.Done():
				return
			case <-time.After(1 * time.Second):
			}
			continue
		}
		for _, stream := range res {
			for _, msg := range stream.Messages {
				if !s.dispatch(msg) {
					return
				}
			}
		}
	}
}

// claimLoop periodically reclaims pending entries left by instances that died
// mid-processing (no XACK). MinIdle guards against stealing a slow-but-alive
// instance's in-flight message.
func (s *RedisSubscriber) claimLoop() {
	defer s.producerWg.Done()
	ticker := time.NewTicker(60 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-s.ctx.Done():
			return
		case <-ticker.C:
			s.claimOnce()
		}
	}
}

func (s *RedisSubscriber) claimOnce() {
	cursor := "0-0"
	for {
		if s.ctx.Err() != nil {
			return
		}
		msgs, next, err := s.redisClient.XAutoClaim(s.ctx, &redis.XAutoClaimArgs{
			Stream:   eventStreamKey,
			Group:    s.cfg.Group,
			Consumer: s.cfg.ConsumerName,
			MinIdle:  s.cfg.ClaimMinIdle,
			Start:    cursor,
			Count:    int64(s.cfg.PoolSize),
		}).Result()
		if err != nil {
			if s.ctx.Err() == nil {
				s.logger.Error("XAutoClaim failed", "error", err)
			}
			return
		}
		if len(msgs) > 0 {
			s.logger.Info("Reclaimed pending events from dead/slow consumer", "count", len(msgs))
		}
		for _, msg := range msgs {
			if !s.dispatch(msg) {
				return
			}
		}
		// Cursor "0-0" means the scan wrapped around — no more pending to claim.
		if next == "0-0" || next == "" {
			return
		}
		cursor = next
	}
}

// dispatch hands a message to the worker pool, returning false if shutting down.
func (s *RedisSubscriber) dispatch(msg redis.XMessage) bool {
	select {
	case s.jobs <- msg:
		return true
	case <-s.ctx.Done():
		return false
	}
}

func (s *RedisSubscriber) worker(id int) {
	defer s.workerWg.Done()
	for msg := range s.jobs {
		s.handleMessage(msg)
		// Ack regardless of handler success. DELETE_FILE failures are already
		// reported to NestJS via gRPC (and its resweep crons retry); CREATE_ZIP
		// failures surface as a failed DownloadJob the client re-requests. Acking
		// here prevents infinite redelivery of a permanently-failing event. A true
		// instance CRASH (process dies before ack) leaves the entry in the PEL,
		// where claimLoop/XAutoClaim redelivers it after ClaimMinIdle.
		if err := s.redisClient.XAck(context.Background(), eventStreamKey, s.cfg.Group, msg.ID).Err(); err != nil {
			s.logger.Error("XAck failed", "workerId", id, "msgId", msg.ID, "error", err)
		}
	}
}

func (s *RedisSubscriber) handleMessage(msg redis.XMessage) {
	raw, ok := msg.Values["payload"].(string)
	if !ok {
		s.logger.Error("Stream message missing 'payload' field", "msgId", msg.ID)
		return
	}

	var event EventMessage
	if err := json.Unmarshal([]byte(raw), &event); err != nil {
		s.logger.Error("Failed to parse event message", "error", err, "msgId", msg.ID)
		return
	}

	switch event.Type {
	case "DELETE_FILE":
		s.handleDeleteFile(event.Payload)
	case "CREATE_ZIP":
		s.handleCreateZip(event.Payload)
	default:
		s.logger.Warn("Unknown event type", "type", event.Type, "msgId", msg.ID)
	}
}

func (s *RedisSubscriber) handleCreateZip(payloadRaw json.RawMessage) {
	if s.zipProcessor == nil {
		s.logger.Warn("Received CREATE_ZIP event but no ZIP processor configured")
		return
	}
	var payload CreateZipPayload
	if err := json.Unmarshal(payloadRaw, &payload); err != nil {
		s.logger.Error("Failed to parse CREATE_ZIP payload", "error", err)
		return
	}
	if payload.JobID == "" {
		s.logger.Error("CREATE_ZIP event missing jobId")
		return
	}
	s.logger.Info("Processing CREATE_ZIP event", "jobId", payload.JobID)
	// Process spawns its own goroutine and returns immediately, so the event is
	// acked once the job is HANDED OFF, not once the ZIP is built. If this
	// instance crashes mid-assembly, the job is NOT redelivered (already acked);
	// instead the NestJS cleanupExpiredZips cron marks stuck jobs (stuck >2h in
	// pending/collecting/zipping) as failed, and the client re-requests. This is
	// the deliberate KISS trade-off over ack-after-complete.
	s.zipProcessor.Process(payload.JobID)
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
