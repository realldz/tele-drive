package queue

import (
	"context"
	"log/slog"
	"time"

	"github.com/redis/go-redis/v9"
)

// Outstanding-counter: a per-file Redis counter of buffered chunks that have been
// accepted by the worker pool but not yet durably persisted in the NestJS DB.
//
// Why Redis (not an in-memory map): chunked upload spans TWO network paths for the
// same fileId. Chunk uploads arrive over HTTP (nginx load-balances across Go
// instances), while completeChunkedUpload's flushAndConfirm arrives over gRPC
// (pinned to whichever instance the gRPC LB chose). With a per-instance map, the
// instance answering flushAndConfirm cannot see chunks still draining on another
// instance, so it would falsely reject a complete upload. A shared Redis counter
// gives every instance the same number regardless of where work landed.
//
// Invariant: each buffered chunk does exactly one INCR (when enqueued) and exactly
// one DECR (when its result is DURABLY flushed to the NestJS DB, or when it
// permanently fails / is discarded before reaching the reporter). The decrement is
// deliberately NOT done when the worker finishes the Telegram upload — at that
// point the result is only queued in the BatchReporter, not yet in the DB, so a
// cross-instance flushAndConfirm could miss it in both `completed` (not in DB) and
// `outstanding` (already decremented). Moving the success-path DECR to the flush
// point keeps the chunk counted until the DB confirms it, closing that gap.

const (
	// outstandingKeyPrefix namespaces the per-file counter keys.
	outstandingKeyPrefix = "upload:outstanding:"

	// outstandingTTL bounds counter leakage if an instance dies mid-drain (INCR
	// done, DECR never reached). Long enough for a large, slow upload to finish;
	// short enough that a crashed instance's stuck counter self-heals. Re-armed on
	// every INCR so an actively-uploading file never expires under itself.
	outstandingTTL = 6 * time.Hour
)

func outstandingKey(fileID string) string {
	return outstandingKeyPrefix + fileID
}

// decrOutstandingScript atomically decrements the counter and deletes the key once
// it reaches zero. Atomicity matters: a plain "DECRBY then DEL if <=0" pair could
// delete a counter that a concurrent INCR (a new chunk for the same file) had just
// bumped back to 1, wrongly dropping an outstanding chunk. Returns the post-decr
// value.
var decrOutstandingScript = redis.NewScript(`
local v = redis.call('DECRBY', KEYS[1], ARGV[1])
if v <= 0 then
  redis.call('DEL', KEYS[1])
end
return v
`)

// incrOutstanding bumps the counter for fileID by one and re-arms its TTL. Logs at
// debug — this fires per accepted chunk and is high-frequency noise at info.
func incrOutstanding(ctx context.Context, rdb *redis.Client, logger *slog.Logger, fileID string) {
	key := outstandingKey(fileID)
	pipe := rdb.Pipeline()
	pipe.Incr(ctx, key)
	pipe.Expire(ctx, key, outstandingTTL)
	if _, err := pipe.Exec(ctx); err != nil {
		// A missed INCR under-counts → a genuinely-complete upload could be falsely
		// rejected. Surface at warn so the operator sees Redis trouble.
		logger.Warn("Failed to incr outstanding counter", "fileId", fileID, "error", err)
	}
}

// decrOutstanding lowers the counter for fileID by n (n>=1). Called once per chunk
// at its durable terminal point. Safe if the key is already gone (DECRBY recreates
// then DEL removes it; net zero).
func decrOutstanding(ctx context.Context, rdb *redis.Client, logger *slog.Logger, fileID string, n int) {
	if n <= 0 {
		return
	}
	key := outstandingKey(fileID)
	if err := decrOutstandingScript.Run(ctx, rdb, []string{key}, n).Err(); err != nil {
		logger.Warn("Failed to decr outstanding counter", "fileId", fileID, "by", n, "error", err)
	}
}

// getOutstanding reads the counter for fileID, clamped at >=0. A missing key (never
// incremented, or already drained to zero and deleted) reads as 0.
func getOutstanding(ctx context.Context, rdb *redis.Client, logger *slog.Logger, fileID string) int32 {
	val, err := rdb.Get(ctx, outstandingKey(fileID)).Int64()
	if err != nil {
		if err == redis.Nil {
			return 0
		}
		logger.Warn("Failed to read outstanding counter", "fileId", fileID, "error", err)
		return 0
	}
	if val < 0 {
		return 0
	}
	if val > int64(^uint32(0)>>1) {
		return int32(^uint32(0) >> 1)
	}
	return int32(val)
}
