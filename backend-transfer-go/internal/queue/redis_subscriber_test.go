// Package queue tests — Redis Stream consumer-group delivery for file:events.
//
// Uses miniredis for an in-process Redis. Covers the three properties that make
// horizontal scaling safe: (1) a published event is delivered to a handler and
// acked exactly once, (2) an empty DELETE_FILE reports success without touching
// Telegram, (3) a pending entry left by a dead consumer is reclaimed via
// XAutoClaim. The Telegram path is intentionally NOT exercised here (it needs a
// live bot API); telegramClient is nil and only empty-message deletes are used.
package queue

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"sync"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/redis/go-redis/v9"
)

// fakeZipProcessor records each jobID handed to Process.
type fakeZipProcessor struct {
	mu   sync.Mutex
	jobs []string
	done chan string
}

func (f *fakeZipProcessor) Process(jobID string) {
	f.mu.Lock()
	f.jobs = append(f.jobs, jobID)
	f.mu.Unlock()
	if f.done != nil {
		f.done <- jobID
	}
}

func (f *fakeZipProcessor) count() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.jobs)
}

// fakeDeleteReporter records ReportDeleteSuccess / ReportDeleteFailed calls.
type fakeDeleteReporter struct {
	mu        sync.Mutex
	successes []string
	failures  []string
	done      chan string
}

func (f *fakeDeleteReporter) ReportDeleteSuccess(_ context.Context, fileID string) error {
	f.mu.Lock()
	f.successes = append(f.successes, fileID)
	f.mu.Unlock()
	if f.done != nil {
		f.done <- fileID
	}
	return nil
}

func (f *fakeDeleteReporter) ReportDeleteFailed(_ context.Context, fileID string, _ string) error {
	f.mu.Lock()
	f.failures = append(f.failures, fileID)
	f.mu.Unlock()
	if f.done != nil {
		f.done <- fileID
	}
	return nil
}

func newTestSubscriber(t *testing.T, zip ZipProcessor, reporter DeleteReporter) (*RedisSubscriber, *miniredis.Miniredis, *redis.Client) {
	t.Helper()
	mr, err := miniredis.Run()
	if err != nil {
		t.Fatalf("miniredis start: %v", err)
	}
	t.Cleanup(mr.Close)

	rdb := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	cfg := SubscriberConfig{
		Group:        "transfer-workers",
		ConsumerName: "test-consumer",
		PoolSize:     2,
		ClaimMinIdle: 0,
	}
	// telegramClient is nil: covered paths (CREATE_ZIP, empty DELETE_FILE) never call it.
	sub := NewRedisSubscriber(rdb, nil, reporter, zip, cfg, logger)
	return sub, mr, rdb
}

// publishEvent mirrors the NestJS XADD: one "payload" field holding {type,payload} JSON.
func publishEvent(t *testing.T, rdb *redis.Client, eventType string, payload any) {
	t.Helper()
	payloadJSON, err := json.Marshal(payload)
	if err != nil {
		t.Fatalf("marshal payload: %v", err)
	}
	envelope, err := json.Marshal(EventMessage{Type: eventType, Payload: payloadJSON})
	if err != nil {
		t.Fatalf("marshal envelope: %v", err)
	}
	if err := rdb.XAdd(context.Background(), &redis.XAddArgs{
		Stream: eventStreamKey,
		Values: map[string]any{"payload": string(envelope)},
	}).Err(); err != nil {
		t.Fatalf("XAdd: %v", err)
	}
}

func waitFor(t *testing.T, ch <-chan string, what string) {
	t.Helper()
	select {
	case <-ch:
	case <-time.After(3 * time.Second):
		t.Fatalf("timed out waiting for %s", what)
	}
}

func TestCreateZipDeliveredAndAckedOnce(t *testing.T) {
	zip := &fakeZipProcessor{done: make(chan string, 1)}
	sub, mr, rdb := newTestSubscriber(t, zip, &fakeDeleteReporter{})

	sub.Start()
	publishEvent(t, rdb, "CREATE_ZIP", CreateZipPayload{JobID: "job-1"})
	waitFor(t, zip.done, "CREATE_ZIP processing")
	sub.Stop() // drains workers + flushes acks

	if got := zip.count(); got != 1 {
		t.Fatalf("expected Process called exactly once, got %d", got)
	}

	// After ack, the consumer group has no pending entries.
	pending, err := rdb.XPending(context.Background(), eventStreamKey, sub.cfg.Group).Result()
	if err != nil {
		t.Fatalf("XPending: %v", err)
	}
	if pending.Count != 0 {
		t.Fatalf("expected 0 pending after ack, got %d", pending.Count)
	}
	_ = mr
}

func TestEmptyDeleteReportsSuccessWithoutTelegram(t *testing.T) {
	reporter := &fakeDeleteReporter{done: make(chan string, 1)}
	sub, _, rdb := newTestSubscriber(t, &fakeZipProcessor{}, reporter)

	sub.Start()
	// No telegramMessageIds → no Telegram calls → straight to ReportDeleteSuccess.
	publishEvent(t, rdb, "DELETE_FILE", DeletePayload{FileID: "file-1", TelegramMessageIDs: []string{}, BotID: 1})
	waitFor(t, reporter.done, "DELETE_FILE report")
	sub.Stop()

	reporter.mu.Lock()
	defer reporter.mu.Unlock()
	if len(reporter.successes) != 1 || reporter.successes[0] != "file-1" {
		t.Fatalf("expected one success for file-1, got successes=%v failures=%v", reporter.successes, reporter.failures)
	}
}

func TestAutoClaimReclaimsPendingFromDeadConsumer(t *testing.T) {
	zip := &fakeZipProcessor{done: make(chan string, 1)}
	sub, mr, rdb := newTestSubscriber(t, zip, &fakeDeleteReporter{})

	// MinIdle guards against stealing a live instance's in-flight message, so the
	// pending entry must look idle past this threshold before it can be reclaimed.
	// miniredis does not advance its clock on its own, and FastForward only ages
	// TTLs (not the stream's delivery clock) — SetTime below controls effectiveNow,
	// which is what XAutoClaim compares lastDelivery against.
	sub.cfg.ClaimMinIdle = time.Minute

	// Pin the clock so the pending entry's lastDelivery is a known instant.
	t0 := time.Now()
	mr.SetTime(t0)

	// Create the group, publish, then read as a DIFFERENT consumer WITHOUT acking
	// — simulating an instance that picked up the message then died.
	if err := sub.ensureGroup(); err != nil {
		t.Fatalf("ensureGroup: %v", err)
	}
	publishEvent(t, rdb, "CREATE_ZIP", CreateZipPayload{JobID: "orphan-job"})
	if _, err := rdb.XReadGroup(context.Background(), &redis.XReadGroupArgs{
		Group:    sub.cfg.Group,
		Consumer: "dead-consumer",
		Streams:  []string{eventStreamKey, ">"},
		Count:    1,
	}).Result(); err != nil {
		t.Fatalf("XReadGroup as dead consumer: %v", err)
	}

	// Advance the clock past ClaimMinIdle so the entry now looks idle enough.
	mr.SetTime(t0.Add(2 * time.Minute))

	// Start workers, then run a claim cycle directly.
	for i := 0; i < sub.cfg.PoolSize; i++ {
		sub.workerWg.Add(1)
		go sub.worker(i)
	}
	sub.claimOnce()
	waitFor(t, zip.done, "reclaimed CREATE_ZIP processing")

	sub.cancel()
	close(sub.jobs)
	sub.workerWg.Wait()

	if got := zip.count(); got != 1 {
		t.Fatalf("expected reclaimed job processed once, got %d", got)
	}
}
