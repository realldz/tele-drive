package telegram

import (
	"context"
	"testing"
	"time"

	"github.com/redis/go-redis/v9"
)

func TestBotRateLimiter(t *testing.T) {
	ctx := context.Background()
	rdb := redis.NewClient(&redis.Options{
		Addr: "localhost:6379",
	})
	
	// Check if Redis is available
	_, err := rdb.Ping(ctx).Result()
	if err != nil {
		t.Skip("Redis not available on localhost:6379, skipping integration test")
		return
	}
	defer rdb.Close()

	// Clear potential keys
	rdb.Del(ctx, "ratelimit:upload:1", "ratelimit:upload:2")

	botIDs := []int64{1, 2}
	limit := 3 // Allow max 3 requests per 60s per bot
	limiter := NewBotRateLimiter(rdb, botIDs, limit)

	// Test acquiring slots
	for i := 0; i < 6; i++ {
		botID, err := limiter.AcquireUploadSlot(ctx)
		if err != nil {
			t.Fatalf("Failed to acquire slot on iteration %d: %v", i, err)
		}
		t.Logf("Acquired bot: %d", botID)
		
		// Space requests slightly so they don't violate the 1-second interval requirement
		time.Sleep(1010 * time.Millisecond)
	}

	// The next slot acquisition should block/wait because both bots (3 slots each) are full for the window
	t.Log("Testing that next acquire blocks...")
	start := time.Now()
	
	// Set a small timeout context to ensure we don't hang forever if something is wrong
	ctxTimeout, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()

	_, err = limiter.AcquireUploadSlot(ctxTimeout)
	if err == nil {
		t.Error("Expected acquisition to block and exceed context deadline")
	} else {
		t.Logf("Acquire blocked correctly: %v (took %v)", err, time.Since(start))
	}
}
