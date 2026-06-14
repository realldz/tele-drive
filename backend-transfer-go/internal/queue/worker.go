package queue

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"time"

	"github.com/redis/go-redis/v9"
)

type Job struct {
	ID        string
	Name      string
	Data      string
	Opts      string
	Attempts  int
	Processed int
}

type JobProcessor func(ctx context.Context, job *Job) error

type BullMQWorker struct {
	rdb       *redis.Client
	queueName string
	processor JobProcessor
	logger    *slog.Logger
}

func NewBullMQWorker(rdb *redis.Client, queueName string, processor JobProcessor, logger *slog.Logger) *BullMQWorker {
	return &BullMQWorker{
		rdb:       rdb,
		queueName: queueName,
		processor: processor,
		logger:    logger,
	}
}

func (w *BullMQWorker) Start(ctx context.Context, concurrency int) {
	for i := 0; i < concurrency; i++ {
		go w.workerLoop(ctx, i)
	}
}

func (w *BullMQWorker) workerLoop(ctx context.Context, workerID int) {
	w.logger.Info("Starting queue worker loop", "queue", w.queueName, "workerID", workerID)

	waitKey := fmt.Sprintf("bull:%s:wait", w.queueName)
	activeKey := fmt.Sprintf("bull:%s:active", w.queueName)

	for {
		select {
		case <-ctx.Done():
			return
		default:
			// Pop from wait and push to active atomically
			jobID, err := w.rdb.BRPopLPush(ctx, waitKey, activeKey, 0).Result()
			if err != nil {
				if ctx.Err() != nil {
					return
				}
				w.logger.Error("Failed to pop job", "queue", w.queueName, "error", err)
				time.Sleep(2 * time.Second)
				continue
			}

			if jobID == "" {
				continue
			}

			w.logger.Info("Processing job", "queue", w.queueName, "jobID", jobID)
			err = w.processJobWithID(ctx, jobID)

			// Remove from active
			w.rdb.LRem(ctx, activeKey, 1, jobID)

			if err != nil {
				w.logger.Error("Job processing failed", "queue", w.queueName, "jobID", jobID, "error", err)
			} else {
				w.logger.Info("Job processing completed successfully", "queue", w.queueName, "jobID", jobID)
			}
		}
	}
}

func (w *BullMQWorker) processJobWithID(ctx context.Context, jobID string) error {
	jobKey := fmt.Sprintf("bull:%s:%s", w.queueName, jobID)
	fields, err := w.rdb.HGetAll(ctx, jobKey).Result()
	if err != nil {
		return fmt.Errorf("failed to get job hash: %w", err)
	}

	if len(fields) == 0 {
		return fmt.Errorf("job hash %s not found", jobKey)
	}

	name := fields["name"]
	dataStr := fields["data"]
	optsStr := fields["opts"]

	var opts struct {
		Attempts int `json:"attempts"`
	}
	_ = json.Unmarshal([]byte(optsStr), &opts)
	if opts.Attempts == 0 {
		opts.Attempts = 1
	}

	attemptsMade := 0
	if val, ok := fields["attemptsMade"]; ok {
		fmt.Sscanf(val, "%d", &attemptsMade)
	}

	job := &Job{
		ID:        jobID,
		Name:      name,
		Data:      dataStr,
		Opts:      optsStr,
		Attempts:  opts.Attempts,
		Processed: attemptsMade,
	}

	// Update attemptsMade in Redis
	attemptsMade++
	w.rdb.HSet(ctx, jobKey, "attemptsMade", fmt.Sprintf("%d", attemptsMade))

	err = w.processor(ctx, job)
	if err == nil {
		// Complete
		w.rdb.Del(ctx, jobKey)
		completedKey := fmt.Sprintf("bull:%s:completed", w.queueName)
		score := float64(time.Now().UnixMilli())
		w.rdb.ZAdd(ctx, completedKey, redis.Z{Score: score, Member: jobID})
		w.rdb.Expire(ctx, completedKey, 1*time.Hour)
		return nil
	}

	// Failure path
	if attemptsMade >= opts.Attempts {
		w.rdb.HSet(ctx, jobKey, "failedReason", err.Error())
		failedKey := fmt.Sprintf("bull:%s:failed", w.queueName)
		score := float64(time.Now().UnixMilli())
		w.rdb.ZAdd(ctx, failedKey, redis.Z{Score: score, Member: jobID})
		w.rdb.Expire(ctx, failedKey, 24*time.Hour)
	} else {
		// Re-enqueue (add back to wait list)
		waitKey := fmt.Sprintf("bull:%s:wait", w.queueName)
		w.rdb.RPush(ctx, waitKey, jobID)
	}

	return err
}
