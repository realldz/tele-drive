package queue

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/redis/go-redis/v9"
)

type BullMQClient struct {
	rdb *redis.Client
}

func NewBullMQClient(rdb *redis.Client) *BullMQClient {
	return &BullMQClient{rdb: rdb}
}

func (b *BullMQClient) AddJob(ctx context.Context, queueName string, jobName string, jobID string, data interface{}, attempts int) error {
	// Generate job ID if not provided
	if jobID == "" {
		idKey := fmt.Sprintf("bull:%s:id", queueName)
		idVal, err := b.rdb.Incr(ctx, idKey).Result()
		if err != nil {
			return err
		}
		jobID = fmt.Sprintf("%d", idVal)
	}

	jobKey := fmt.Sprintf("bull:%s:%s", queueName, jobID)
	dataBytes, err := json.Marshal(data)
	if err != nil {
		return err
	}

	opts := map[string]interface{}{
		"attempts": attempts,
		"backoff": map[string]interface{}{
			"type":  "exponential",
			"delay": 5000,
		},
		"removeOnComplete": true,
		"removeOnFail":     100,
	}
	optsBytes, _ := json.Marshal(opts)

	timestamp := time.Now().UnixNano() / int64(time.Millisecond)

	pipe := b.rdb.Pipeline()
	pipe.HSet(ctx, jobKey, map[string]interface{}{
		"name":      jobName,
		"data":      string(dataBytes),
		"opts":      string(optsBytes),
		"timestamp": fmt.Sprintf("%d", timestamp),
		"delay":     "0",
		"priority":  "0",
	})

	// Add to wait list
	waitKey := fmt.Sprintf("bull:%s:wait", queueName)
	pipe.LPush(ctx, waitKey, jobID)

	// Publish message to waiting-jobs channel to wake up workers
	pubSubChan := fmt.Sprintf("bull:%s:waiting-jobs", queueName)
	pipe.Publish(ctx, pubSubChan, jobID)

	_, err = pipe.Exec(ctx)
	return err
}
