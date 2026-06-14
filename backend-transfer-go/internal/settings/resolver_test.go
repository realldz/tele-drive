// Package settings tests — Resolver in-memory TTL cache + gRPC refresh.
//
// Uses a fake settingsFetcher for the gRPC side, so the resolver is exercised
// end-to-end with no live dependencies. No Redis: the cache is purely in-memory.
package settings

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// fakeFetcher is an in-memory settingsFetcher. callCount tracks how many times
// the gRPC fetch path was hit (used to assert cache + singleflight behavior).
type fakeFetcher struct {
	mu        sync.Mutex
	settings  map[string]string
	err       error
	callCount int64
	// delay simulates gRPC latency so the singleflight test can race goroutines.
	delay time.Duration
}

func (f *fakeFetcher) GetSystemSettings(_ context.Context, _ []string) (map[string]string, error) {
	atomic.AddInt64(&f.callCount, 1)
	if f.delay > 0 {
		time.Sleep(f.delay)
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.err != nil {
		return nil, f.err
	}
	// Return a copy so the resolver can't mutate the fake's backing map.
	out := make(map[string]string, len(f.settings))
	for k, v := range f.settings {
		out[k] = v
	}
	return out, nil
}

func (f *fakeFetcher) setSettings(m map[string]string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.settings = m
}

func newTestResolver(fetcher settingsFetcher) *Resolver {
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	return NewResolver(fetcher, logger)
}

func TestResolver_FetchAndParse(t *testing.T) {
	fetcher := &fakeFetcher{settings: map[string]string{
		"MAX_CONCURRENT_CHUNKS":     "5",
		"DOWNLOAD_URL_TTL_SECONDS":  "600",
		"MAX_BUFFER_FILE_SIZE":      "104857600",
		"ENABLE_MULTI_THREAD_DOWNLOAD": "false",
	}}
	r := newTestResolver(fetcher)
	ctx := context.Background()

	if got := r.GetInt(ctx, "MAX_CONCURRENT_CHUNKS", 3); got != 5 {
		t.Errorf("GetInt = %d, want 5", got)
	}
	if got := r.GetInt(ctx, "DOWNLOAD_URL_TTL_SECONDS", 300); got != 600 {
		t.Errorf("GetInt ttl = %d, want 600", got)
	}
	if got := r.GetInt64(ctx, "MAX_BUFFER_FILE_SIZE", 52428800); got != 104857600 {
		t.Errorf("GetInt64 = %d, want 104857600", got)
	}
	if got := r.GetBool(ctx, "ENABLE_MULTI_THREAD_DOWNLOAD", true); got != false {
		t.Errorf("GetBool = %v, want false", got)
	}
}

func TestResolver_DefaultsOnAbsentKey(t *testing.T) {
	fetcher := &fakeFetcher{settings: map[string]string{}}
	r := newTestResolver(fetcher)
	ctx := context.Background()

	if got := r.GetInt(ctx, "MISSING", 3); got != 3 {
		t.Errorf("GetInt absent = %d, want default 3", got)
	}
	if got := r.GetString(ctx, "MISSING", "fallback"); got != "fallback" {
		t.Errorf("GetString absent = %q, want fallback", got)
	}
	if got := r.GetBool(ctx, "MISSING", true); got != true {
		t.Errorf("GetBool absent = %v, want default true", got)
	}
}

func TestResolver_DefaultsOnParseError(t *testing.T) {
	fetcher := &fakeFetcher{settings: map[string]string{
		"MAX_CONCURRENT_CHUNKS": "not-a-number",
	}}
	r := newTestResolver(fetcher)
	if got := r.GetInt(context.Background(), "MAX_CONCURRENT_CHUNKS", 3); got != 3 {
		t.Errorf("GetInt parse error = %d, want default 3", got)
	}
}

func TestResolver_CacheHit_NoRefetch(t *testing.T) {
	fetcher := &fakeFetcher{settings: map[string]string{"MAX_CONCURRENT_CHUNKS": "5"}}
	r := newTestResolver(fetcher)
	ctx := context.Background()

	for i := 0; i < 10; i++ {
		r.GetInt(ctx, "MAX_CONCURRENT_CHUNKS", 3)
	}
	if c := atomic.LoadInt64(&fetcher.callCount); c != 1 {
		t.Errorf("callCount = %d, want 1 (cached after first fetch)", c)
	}
}

func TestResolver_FailSoft_ServesStale(t *testing.T) {
	fetcher := &fakeFetcher{settings: map[string]string{"MAX_CONCURRENT_CHUNKS": "5"}}
	r := newTestResolver(fetcher)
	ctx := context.Background()

	// Prime the cache.
	if got := r.GetInt(ctx, "MAX_CONCURRENT_CHUNKS", 3); got != 5 {
		t.Fatalf("initial GetInt = %d, want 5", got)
	}

	// Expire the cache and make the next fetch fail.
	r.mu.Lock()
	r.expiry = time.Now().Add(-time.Minute)
	r.mu.Unlock()
	fetcher.mu.Lock()
	fetcher.err = errors.New("nestjs down")
	fetcher.mu.Unlock()

	// Stale snapshot should still be served (fail-soft), not the default.
	if got := r.GetInt(ctx, "MAX_CONCURRENT_CHUNKS", 3); got != 5 {
		t.Errorf("fail-soft GetInt = %d, want stale 5", got)
	}
}

func TestResolver_ColdStart_NestJSDown_UsesDefault(t *testing.T) {
	fetcher := &fakeFetcher{err: errors.New("nestjs down")}
	r := newTestResolver(fetcher)
	// No prior snapshot + fetch fails → caller default.
	if got := r.GetInt(context.Background(), "MAX_CONCURRENT_CHUNKS", 3); got != 3 {
		t.Errorf("cold-start GetInt = %d, want default 3", got)
	}
}

func TestResolver_RefreshAfterTTL(t *testing.T) {
	fetcher := &fakeFetcher{settings: map[string]string{"MAX_CONCURRENT_CHUNKS": "5"}}
	r := newTestResolver(fetcher)
	ctx := context.Background()

	if got := r.GetInt(ctx, "MAX_CONCURRENT_CHUNKS", 3); got != 5 {
		t.Fatalf("initial = %d, want 5", got)
	}

	// Admin changes the value; expire the cache to force a refresh.
	fetcher.setSettings(map[string]string{"MAX_CONCURRENT_CHUNKS": "8"})
	r.mu.Lock()
	r.expiry = time.Now().Add(-time.Minute)
	r.mu.Unlock()

	if got := r.GetInt(ctx, "MAX_CONCURRENT_CHUNKS", 3); got != 8 {
		t.Errorf("post-refresh = %d, want 8", got)
	}
	if c := atomic.LoadInt64(&fetcher.callCount); c != 2 {
		t.Errorf("callCount = %d, want 2 (initial + refresh)", c)
	}
}

func TestResolver_Singleflight_CollapsesConcurrent(t *testing.T) {
	fetcher := &fakeFetcher{
		settings: map[string]string{"MAX_CONCURRENT_CHUNKS": "5"},
		delay:    50 * time.Millisecond,
	}
	r := newTestResolver(fetcher)
	ctx := context.Background()

	var wg sync.WaitGroup
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			r.GetInt(ctx, "MAX_CONCURRENT_CHUNKS", 3)
		}()
	}
	wg.Wait()

	// 20 concurrent cold misses should collapse into a single gRPC call.
	if c := atomic.LoadInt64(&fetcher.callCount); c != 1 {
		t.Errorf("callCount = %d, want 1 (singleflight collapse)", c)
	}
}
