// Package s3auth tests — CredentialResolver Redis-first + gRPC fallback.
//
// Uses miniredis for an in-process Redis and a fake credentialFetcher for the
// gRPC side, so the resolver is exercised end-to-end with no live dependencies.
package s3auth

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	pb "github.com/realldz/tele-drive/backend-transfer-go/internal/grpc/proto"
	"github.com/redis/go-redis/v9"
)

// fakeFetcher is an in-memory credentialFetcher. callCount tracks how many times
// the gRPC fetch path was hit (used to assert cache + singleflight behavior).
type fakeFetcher struct {
	resp      *pb.GetS3CredentialResponse
	err       error
	callCount int64
	// delay simulates gRPC latency so the singleflight test can race goroutines.
	delay time.Duration
}

func (f *fakeFetcher) GetS3Credential(_ context.Context, _ string) (*pb.GetS3CredentialResponse, error) {
	atomic.AddInt64(&f.callCount, 1)
	if f.delay > 0 {
		time.Sleep(f.delay)
	}
	if f.err != nil {
		return nil, f.err
	}
	return f.resp, nil
}

// newTestResolver wires miniredis + fake fetcher into a resolver.
func newTestResolver(t *testing.T, fetcher credentialFetcher) (*CredentialResolver, *miniredis.Miniredis) {
	t.Helper()
	mr, err := miniredis.Run()
	if err != nil {
		t.Fatalf("miniredis start: %v", err)
	}
	t.Cleanup(mr.Close)

	rdb := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	return NewCredentialResolver(rdb, fetcher, logger), mr
}

func ctxWithReqID(id string) context.Context {
	return context.WithValue(context.Background(), requestIDKey, id)
}

func TestResolver_CacheMiss_FetchSuccess(t *testing.T) {
	fetcher := &fakeFetcher{resp: &pb.GetS3CredentialResponse{
		Found: true, IsActive: true, UserId: "user-1", SecretAccessKey: "secret-1",
	}}
	r, mr := newTestResolver(t, fetcher)

	secret, userID, active, err := r.Get(ctxWithReqID("req-1"), "AKIA1")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if secret != "secret-1" || userID != "user-1" || !active {
		t.Errorf("got (%q,%q,%v), want (secret-1,user-1,true)", secret, userID, active)
	}
	if fetcher.callCount != 1 {
		t.Errorf("gRPC calls: got %d, want 1", fetcher.callCount)
	}
	// Cache must be populated with the active TTL.
	if !mr.Exists(credCacheKeyPrefix + "AKIA1") {
		t.Error("expected cache entry after fetch")
	}
}

func TestResolver_CacheHit_NoFetch(t *testing.T) {
	fetcher := &fakeFetcher{resp: &pb.GetS3CredentialResponse{
		Found: true, IsActive: true, UserId: "user-1", SecretAccessKey: "secret-1",
	}}
	r, _ := newTestResolver(t, fetcher)

	// First call populates cache.
	if _, _, _, err := r.Get(ctxWithReqID("req-1"), "AKIA1"); err != nil {
		t.Fatalf("first call: %v", err)
	}
	// Second call must be served from cache.
	if _, _, _, err := r.Get(ctxWithReqID("req-2"), "AKIA1"); err != nil {
		t.Fatalf("second call: %v", err)
	}
	if fetcher.callCount != 1 {
		t.Errorf("gRPC calls: got %d, want 1 (second served from cache)", fetcher.callCount)
	}
}

func TestResolver_CacheMiss_NotFound_Tombstone(t *testing.T) {
	fetcher := &fakeFetcher{resp: &pb.GetS3CredentialResponse{Found: false}}
	r, mr := newTestResolver(t, fetcher)

	_, _, _, err := r.Get(ctxWithReqID("req-1"), "AKIAUNKNOWN")
	if !errors.Is(err, ErrCredentialNotFound) {
		t.Errorf("got %v, want ErrCredentialNotFound", err)
	}
	// Tombstone must be cached so the next request does NOT re-fetch.
	if !mr.Exists(credCacheKeyPrefix + "AKIAUNKNOWN") {
		t.Error("expected tombstone cache entry")
	}

	if _, _, _, err := r.Get(ctxWithReqID("req-2"), "AKIAUNKNOWN"); !errors.Is(err, ErrCredentialNotFound) {
		t.Errorf("second call: got %v, want ErrCredentialNotFound", err)
	}
	if fetcher.callCount != 1 {
		t.Errorf("gRPC calls: got %d, want 1 (tombstone served from cache)", fetcher.callCount)
	}
}

func TestResolver_CacheHitTombstone(t *testing.T) {
	fetcher := &fakeFetcher{resp: &pb.GetS3CredentialResponse{Found: false}}
	r, mr := newTestResolver(t, fetcher)

	// Pre-seed a tombstone directly.
	tomb, _ := json.Marshal(&CachedCredential{AccessKeyID: "AKIAX", Found: false})
	mr.Set(credCacheKeyPrefix+"AKIAX", string(tomb))

	_, _, _, err := r.Get(ctxWithReqID("req-1"), "AKIAX")
	if !errors.Is(err, ErrCredentialNotFound) {
		t.Errorf("got %v, want ErrCredentialNotFound", err)
	}
	if fetcher.callCount != 0 {
		t.Errorf("gRPC calls: got %d, want 0 (served from tombstone)", fetcher.callCount)
	}
}

func TestResolver_FetchError_Propagates(t *testing.T) {
	fetcher := &fakeFetcher{err: errors.New("grpc unavailable")}
	r, mr := newTestResolver(t, fetcher)

	_, _, _, err := r.Get(ctxWithReqID("req-1"), "AKIA1")
	if err == nil {
		t.Fatal("expected error from gRPC fetch")
	}
	if errors.Is(err, ErrCredentialNotFound) {
		t.Error("transport error should NOT map to ErrCredentialNotFound")
	}
	// Transport errors must NOT be cached — next request retries.
	if mr.Exists(credCacheKeyPrefix + "AKIA1") {
		t.Error("transport error should not populate cache")
	}
}

func TestResolver_InactiveCredential(t *testing.T) {
	fetcher := &fakeFetcher{resp: &pb.GetS3CredentialResponse{
		Found: true, IsActive: false, UserId: "user-1", SecretAccessKey: "secret-1",
	}}
	r, _ := newTestResolver(t, fetcher)

	_, _, active, err := r.Get(ctxWithReqID("req-1"), "AKIA1")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if active {
		t.Error("expected active=false for deactivated credential")
	}
}

func TestResolver_Singleflight_CollapsesConcurrentMisses(t *testing.T) {
	fetcher := &fakeFetcher{
		resp:  &pb.GetS3CredentialResponse{Found: true, IsActive: true, UserId: "u", SecretAccessKey: "s"},
		delay: 50 * time.Millisecond,
	}
	r, _ := newTestResolver(t, fetcher)

	const goroutines = 20
	var wg sync.WaitGroup
	wg.Add(goroutines)
	for i := 0; i < goroutines; i++ {
		go func() {
			defer wg.Done()
			_, _, _, _ = r.Get(ctxWithReqID("req"), "AKIASAME")
		}()
	}
	wg.Wait()

	// Singleflight must collapse all concurrent misses into ONE gRPC call.
	if got := atomic.LoadInt64(&fetcher.callCount); got != 1 {
		t.Errorf("gRPC calls: got %d, want 1 (singleflight collapse)", got)
	}
}
