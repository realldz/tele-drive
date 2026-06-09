package telegram

import (
	"context"
	"fmt"
	"strconv"
	"strings"
	"sync/atomic"
	"time"

	"github.com/google/uuid"
	"github.com/redis/go-redis/v9"
)

const AcquireSlotLua = `
  local key = KEYS[1]
  local now = tonumber(ARGV[1])
  local windowMs = tonumber(ARGV[2])
  local limit = tonumber(ARGV[3])
  local uuid = ARGV[4]

  redis.call('ZREMRANGEBYSCORE', key, '-inf', now - windowMs)
  
  local latest = redis.call('ZRANGE', key, -1, -1, 'WITHSCORES')
  if latest and #latest >= 2 then
    local latestScore = tonumber(latest[2])
    if now - latestScore < 1000 then
      return 0
    end
  end

  local count = redis.call('ZCARD', key)
  if count < limit then
    redis.call('ZADD', key, now, uuid)
    redis.call('PEXPIRE', key, windowMs + 10000)
    return 1
  end
  return 0
`

type BotRateLimiter struct {
	rdb      *redis.Client
	botIDs   []int64
	windowMs int64
	limit    int
	luaSHA   string
	rrIndex  uint32
}

func NewBotRateLimiter(rdb *redis.Client, botIDs []int64, limit int) *BotRateLimiter {
	// Pre-compile the Lua script
	sha, err := rdb.ScriptLoad(context.Background(), AcquireSlotLua).Result()
	if err != nil {
		// Fallback to sending raw script if script load fails
		sha = ""
	}

	return &BotRateLimiter{
		rdb:      rdb,
		botIDs:   botIDs,
		windowMs: 60000, // 60 seconds
		limit:    limit,
		luaSHA:   sha,
	}
}

func (rl *BotRateLimiter) AcquireUploadSlot(ctx context.Context) (int64, error) {
	reqUUID := uuid.New().String()

	for {
		select {
		case <-ctx.Done():
			return 0, ctx.Err()
		default:
		}

		now := time.Now().UnixNano() / int64(time.Millisecond)
		botCount := len(rl.botIDs)
		if botCount == 0 {
			return 0, fmt.Errorf("no bots configured")
		}

		// Round-robin index selection
		idx := atomic.AddUint32(&rl.rrIndex, 1) - 1
		startIdx := int(idx % uint32(botCount))

		var acquiredBotID int64 = 0

		for i := 0; i < botCount; i++ {
			botID := rl.botIDs[(startIdx+i)%botCount]
			key := fmt.Sprintf("ratelimit:upload:%d", botID)

			var res interface{}
			var err error
			if rl.luaSHA != "" {
				res, err = rl.rdb.EvalSha(ctx, rl.luaSHA, []string{key}, now, rl.windowMs, rl.limit, reqUUID).Result()
				if err != nil && strings.Contains(err.Error(), "NOSCRIPT") {
					// Fallback to eval
					res, err = rl.rdb.Eval(ctx, AcquireSlotLua, []string{key}, now, rl.windowMs, rl.limit, reqUUID).Result()
				}
			} else {
				res, err = rl.rdb.Eval(ctx, AcquireSlotLua, []string{key}, now, rl.windowMs, rl.limit, reqUUID).Result()
			}

			if err != nil {
				// Log error and continue to next bot
				continue
			}

			if val, ok := res.(int64); ok && val == 1 {
				acquiredBotID = botID
				break
			}
		}

		if acquiredBotID != 0 {
			return acquiredBotID, nil
		}

		// All bots are full - wait
		waitMs, err := rl.GetWaitTimeMs(ctx)
		if err != nil {
			waitMs = 1000 // default fallback wait
		} else if waitMs > 0 {
			waitMs += 100 // add extra buffer to prevent double-hitting
		} else {
			waitMs = 1000
		}

		select {
		case <-ctx.Done():
			return 0, ctx.Err()
		case <-time.After(time.Duration(waitMs) * time.Millisecond):
		}
	}
}

func (rl *BotRateLimiter) GetWaitTimeMs(ctx context.Context) (int64, error) {
	botCount := len(rl.botIDs)
	if botCount == 0 {
		return 0, nil
	}

	now := time.Now().UnixNano() / int64(time.Millisecond)
	pipe := rl.rdb.Pipeline()

	for _, botID := range rl.botIDs {
		key := fmt.Sprintf("ratelimit:upload:%d", botID)
		pipe.ZRemRangeByScore(ctx, key, "-inf", strconv.FormatInt(now-rl.windowMs, 10))
		pipe.ZCard(ctx, key)
		pipe.ZRangeWithScores(ctx, key, 0, 0)
		pipe.ZRangeWithScores(ctx, key, -1, -1)
	}

	cmders, err := pipe.Exec(ctx)
	// Ignore redis.Nil, but check other critical errors
	if err != nil && err != redis.Nil {
		return 0, err
	}

	minWait := rl.windowMs
	anyAvailable := false

	for i := 0; i < botCount; i++ {
		offset := i * 4
		cardCmd := cmders[offset+1].(*redis.IntCmd)
		oldestCmd := cmders[offset+2].(*redis.ZSliceCmd)
		latestCmd := cmders[offset+3].(*redis.ZSliceCmd)

		count, err := cardCmd.Result()
		if err != nil {
			continue
		}

		if count < int64(rl.limit) {
			// Has capacity in 60s window. Now check 1s interval.
			var wait int64 = 0
			latest, err := latestCmd.Result()
			if err == nil && len(latest) > 0 {
				latestScore := int64(latest[0].Score)
				wait = latestScore + 1000 - now
			}
			if wait <= 0 {
				anyAvailable = true
				return 0, nil // Bot is immediately available
			}
			if wait < minWait {
				minWait = wait
			}
		} else {
			// Window is full. Must wait for oldest slot to expire.
			var wait = rl.windowMs
			oldest, err := oldestCmd.Result()
			if err == nil && len(oldest) > 0 {
				oldestScore := int64(oldest[0].Score)
				wait = oldestScore + rl.windowMs - now
			}
			if wait < minWait {
				minWait = wait
			}
		}
	}

	if anyAvailable {
		return 0, nil
	}
	if minWait < 0 {
		return 0, nil
	}
	return minWait, nil
}
