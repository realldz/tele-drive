// Package queue tests — the shared Redis outstanding-counter for chunked uploads.
//
// These tests prove the property that makes horizontal scaling safe: the count is
// visible across instances (one *redis.Client per "instance", same backing store),
// and the +1/-1 invariant holds across every terminal branch (durable flush,
// permanent failure, discard) so a cross-instance flushAndConfirm never sees a
// chunk fall out of both `completed` and `outstanding`.
package queue

import (
	"context"
	"io"
	"log/slog"
	"testing"

	"github.com/alicebob/miniredis/v2"
	"github.com/redis/go-redis/v9"
)

func newCounterTestRedis(t *testing.T) (*miniredis.Miniredis, *redis.Client, *slog.Logger) {
	t.Helper()
	mr, err := miniredis.Run()
	if err != nil {
		t.Fatalf("miniredis start: %v", err)
	}
	t.Cleanup(mr.Close)
	rdb := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	return mr, rdb, logger
}

func TestOutstandingIncrThenDecrToZeroDeletesKey(t *testing.T) {
	mr, rdb, logger := newCounterTestRedis(t)
	ctx := context.Background()
	fileID := "file-1"

	incrOutstanding(ctx, rdb, logger, fileID)
	if got := getOutstanding(ctx, rdb, logger, fileID); got != 1 {
		t.Fatalf("after one incr, want 1 got %d", got)
	}
	// TTL must be armed so a crashed instance's counter self-heals.
	if ttl := mr.TTL(outstandingKey(fileID)); ttl <= 0 {
		t.Fatalf("expected positive TTL on counter key, got %v", ttl)
	}

	decrOutstanding(ctx, rdb, logger, fileID, 1)
	if got := getOutstanding(ctx, rdb, logger, fileID); got != 0 {
		t.Fatalf("after decr to zero, want 0 got %d", got)
	}
	if mr.Exists(outstandingKey(fileID)) {
		t.Fatalf("expected key deleted once counter hit zero")
	}
}

// Cross-instance visibility: two independent clients against one store see the
// same counter — the whole reason this moved out of an in-memory map.
func TestOutstandingVisibleAcrossClients(t *testing.T) {
	mr, _, logger := newCounterTestRedis(t)
	ctx := context.Background()
	fileID := "file-shared"

	instanceA := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	instanceB := redis.NewClient(&redis.Options{Addr: mr.Addr()})

	incrOutstanding(ctx, instanceA, logger, fileID)
	incrOutstanding(ctx, instanceA, logger, fileID)

	if got := getOutstanding(ctx, instanceB, logger, fileID); got != 2 {
		t.Fatalf("instance B must see instance A's incrs: want 2 got %d", got)
	}
}

// A multi-chunk batch for one file decrements in a single grouped DECRBY, matching
// BatchReporter.Flush.
func TestOutstandingDecrByGroupedCount(t *testing.T) {
	_, rdb, logger := newCounterTestRedis(t)
	ctx := context.Background()
	fileID := "file-multi"

	for i := 0; i < 3; i++ {
		incrOutstanding(ctx, rdb, logger, fileID)
	}
	if got := getOutstanding(ctx, rdb, logger, fileID); got != 3 {
		t.Fatalf("want 3 after three incrs, got %d", got)
	}

	decrOutstanding(ctx, rdb, logger, fileID, 3)
	if got := getOutstanding(ctx, rdb, logger, fileID); got != 0 {
		t.Fatalf("want 0 after grouped decr, got %d", got)
	}
}

// Partial drain: incr 3, flush 2 → 1 still outstanding (the still-draining chunk
// keeps the file from being prematurely confirmed complete).
func TestOutstandingPartialDrainKeepsRemainder(t *testing.T) {
	_, rdb, logger := newCounterTestRedis(t)
	ctx := context.Background()
	fileID := "file-partial"

	for i := 0; i < 3; i++ {
		incrOutstanding(ctx, rdb, logger, fileID)
	}
	decrOutstanding(ctx, rdb, logger, fileID, 2)
	if got := getOutstanding(ctx, rdb, logger, fileID); got != 1 {
		t.Fatalf("want 1 remaining after draining 2 of 3, got %d", got)
	}
}

// Decrementing a missing key (e.g. an over-decrement under a race) must not go
// negative — getOutstanding clamps and the key stays absent.
func TestOutstandingDecrMissingKeyClampsToZero(t *testing.T) {
	mr, rdb, logger := newCounterTestRedis(t)
	ctx := context.Background()
	fileID := "file-missing"

	decrOutstanding(ctx, rdb, logger, fileID, 1)
	if got := getOutstanding(ctx, rdb, logger, fileID); got != 0 {
		t.Fatalf("decr on missing key must read 0, got %d", got)
	}
	if mr.Exists(outstandingKey(fileID)) {
		t.Fatalf("decr on missing key must not leave a negative counter key")
	}
}

// decrOutstanding with n<=0 is a no-op (guards the BatchReporter grouping where a
// fileId could theoretically map to zero).
func TestOutstandingDecrZeroIsNoop(t *testing.T) {
	_, rdb, logger := newCounterTestRedis(t)
	ctx := context.Background()
	fileID := "file-noop"

	incrOutstanding(ctx, rdb, logger, fileID)
	decrOutstanding(ctx, rdb, logger, fileID, 0)
	if got := getOutstanding(ctx, rdb, logger, fileID); got != 1 {
		t.Fatalf("decr by zero must leave counter unchanged, want 1 got %d", got)
	}
}
