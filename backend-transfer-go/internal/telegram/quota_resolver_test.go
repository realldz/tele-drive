// Package telegram tests — QuotaResolver Redis-first + gRPC fallback for the
// three bandwidth quota tiers (user daily / guest-IP daily / per-file).
//
// Uses miniredis for an in-process Redis and a fake quotaFetcher for the gRPC
// side, so the resolver is exercised end-to-end with no live dependencies.
package telegram

import (
	"context"
	"io"
	"log/slog"
	"strconv"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	pb "github.com/realldz/tele-drive/backend-transfer-go/internal/grpc/proto"
	"github.com/alicebob/miniredis/v2"
	"github.com/redis/go-redis/v9"
)

// fakeQuotaFetcher is an in-memory quotaFetcher. callCount tracks gRPC fetches
// (asserts cache + singleflight behavior).
type fakeQuotaFetcher struct {
	resp      *pb.GetBandwidthQuotaResponse
	err       error
	callCount int64
	delay     time.Duration
}

func (f *fakeQuotaFetcher) GetBandwidthQuota(_ context.Context, _, _, _ string) (*pb.GetBandwidthQuotaResponse, error) {
	atomic.AddInt64(&f.callCount, 1)
	if f.delay > 0 {
		time.Sleep(f.delay)
	}
	if f.err != nil {
		return nil, f.err
	}
	return f.resp, nil
}

func newTestQuotaResolver(t *testing.T, fetcher quotaFetcher) (*QuotaResolver, *miniredis.Miniredis) {
	t.Helper()
	mr, err := miniredis.Run()
	if err != nil {
		t.Fatalf("miniredis start: %v", err)
	}
	t.Cleanup(mr.Close)

	rdb := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	return NewQuotaResolver(rdb, fetcher, logger), mr
}

func quotaCtx(id string) context.Context {
	return context.WithValue(context.Background(), quotaRequestIDKey, id)
}

// nowISO returns an RFC3339 timestamp `hoursAgo` hours in the past.
func nowISO(hoursAgo float64) string {
	return time.Now().Add(-time.Duration(hoursAgo*float64(time.Hour))).UTC().Format(time.RFC3339)
}

func TestQuota_UserUnderLimit_AllowsAndSeeds(t *testing.T) {
	fetcher := &fakeQuotaFetcher{resp: &pb.GetBandwidthQuotaResponse{
		DailyUsed: 100, DailyLimit: 1000, LastReset: nowISO(1),
	}}
	r, mr := newTestQuotaResolver(t, fetcher)

	d := r.CheckAndLock(quotaCtx("req-1"), "user-1", "1.2.3.4", "", 200)
	if !d.Allowed {
		t.Fatalf("expected allowed, got %+v", d)
	}
	if fetcher.callCount != 1 {
		t.Errorf("gRPC calls: got %d, want 1", fetcher.callCount)
	}
	// Seeded + locked: 100 (db) + 200 (lock) = 300.
	got, _ := strconv.ParseInt(mr.HGet(userQuotaKey("user-1"), "dailyBandwidthUsed"), 10, 64)
	if got != 300 {
		t.Errorf("dailyBandwidthUsed: got %d, want 300", got)
	}
}

func TestQuota_UserOverLimit_Rejects(t *testing.T) {
	fetcher := &fakeQuotaFetcher{resp: &pb.GetBandwidthQuotaResponse{
		DailyUsed: 900, DailyLimit: 1000, LastReset: nowISO(1),
	}}
	r, _ := newTestQuotaResolver(t, fetcher)

	d := r.CheckAndLock(quotaCtx("req-1"), "user-1", "", "", 200)
	if d.Allowed {
		t.Fatal("expected rejection (900+200 > 1000)")
	}
	if d.Code != "USER_BANDWIDTH_LIMIT" {
		t.Errorf("code: got %q, want USER_BANDWIDTH_LIMIT", d.Code)
	}
	if d.ResetAt == "" {
		t.Error("expected non-empty ResetAt")
	}
}

func TestQuota_UnlimitedWhenZeroLimit(t *testing.T) {
	fetcher := &fakeQuotaFetcher{resp: &pb.GetBandwidthQuotaResponse{
		DailyUsed: 1 << 40, DailyLimit: 0, LastReset: nowISO(1),
	}}
	r, _ := newTestQuotaResolver(t, fetcher)

	d := r.CheckAndLock(quotaCtx("req-1"), "user-1", "", "", 1<<30)
	if !d.Allowed {
		t.Fatal("limit=0 means unlimited; expected allowed")
	}
}

func TestQuota_CacheHit_NoRefetch_WhenNoFile(t *testing.T) {
	fetcher := &fakeQuotaFetcher{resp: &pb.GetBandwidthQuotaResponse{
		DailyUsed: 0, DailyLimit: 10000, LastReset: nowISO(1),
	}}
	r, _ := newTestQuotaResolver(t, fetcher)

	// First seeds, second must hit cache (no fileId).
	r.CheckAndLock(quotaCtx("req-1"), "user-1", "", "", 100)
	r.CheckAndLock(quotaCtx("req-2"), "user-1", "", "", 100)
	if fetcher.callCount != 1 {
		t.Errorf("gRPC calls: got %d, want 1 (second served from cache)", fetcher.callCount)
	}
}

func TestQuota_PerFile_AlwaysRefetches(t *testing.T) {
	fetcher := &fakeQuotaFetcher{resp: &pb.GetBandwidthQuotaResponse{
		DailyUsed: 0, DailyLimit: 10000, LastReset: nowISO(1),
		FileDownloads_24H: 0, FileDownloadLimit_24H: 0,
	}}
	r, _ := newTestQuotaResolver(t, fetcher)

	// A fileId in play must always pull fresh per-file counters.
	r.CheckAndLock(quotaCtx("req-1"), "user-1", "", "file-1", 100)
	r.CheckAndLock(quotaCtx("req-2"), "user-1", "", "file-1", 100)
	if fetcher.callCount != 2 {
		t.Errorf("gRPC calls: got %d, want 2 (per-file always refetched)", fetcher.callCount)
	}
}

func TestQuota_FileDownloadLimit_Rejects(t *testing.T) {
	fetcher := &fakeQuotaFetcher{resp: &pb.GetBandwidthQuotaResponse{
		DailyUsed: 0, DailyLimit: 0, LastReset: nowISO(1),
		FileDownloads_24H: 5, FileDownloadLimit_24H: 5,
		FileLastDownloadReset: nowISO(1),
	}}
	r, _ := newTestQuotaResolver(t, fetcher)

	d := r.CheckAndLock(quotaCtx("req-1"), "user-1", "", "file-1", 100)
	if d.Allowed {
		t.Fatal("expected rejection (downloads 5 >= limit 5)")
	}
	if d.Code != "FILE_DOWNLOAD_LIMIT" {
		t.Errorf("code: got %q, want FILE_DOWNLOAD_LIMIT", d.Code)
	}
}

func TestQuota_FileBandwidthLimit_Rejects(t *testing.T) {
	fetcher := &fakeQuotaFetcher{resp: &pb.GetBandwidthQuotaResponse{
		DailyUsed: 0, DailyLimit: 0, LastReset: nowISO(1),
		FileBandwidthUsed_24H: 900, FileBandwidthLimit_24H: 1000,
		FileLastDownloadReset: nowISO(1),
	}}
	r, _ := newTestQuotaResolver(t, fetcher)

	d := r.CheckAndLock(quotaCtx("req-1"), "user-1", "", "file-1", 200)
	if d.Allowed {
		t.Fatal("expected rejection (900+200 > 1000)")
	}
	if d.Code != "FILE_BANDWIDTH_LIMIT" {
		t.Errorf("code: got %q, want FILE_BANDWIDTH_LIMIT", d.Code)
	}
}

func TestQuota_Guest_KeyedByIP(t *testing.T) {
	fetcher := &fakeQuotaFetcher{resp: &pb.GetBandwidthQuotaResponse{
		DailyUsed: 0, DailyLimit: 500, LastReset: nowISO(1), IsGuest: true,
	}}
	r, mr := newTestQuotaResolver(t, fetcher)

	d := r.CheckAndLock(quotaCtx("req-1"), "", "9.9.9.9", "", 100)
	if !d.Allowed {
		t.Fatalf("expected allowed, got %+v", d)
	}
	// Guest hash keyed by ip, not user.
	if !mr.Exists(guestQuotaCacheKey("9.9.9.9")) {
		t.Error("expected guest quota hash seeded")
	}
}

func TestQuota_Guest_OverLimit_Rejects(t *testing.T) {
	fetcher := &fakeQuotaFetcher{resp: &pb.GetBandwidthQuotaResponse{
		DailyUsed: 450, DailyLimit: 500, LastReset: nowISO(1), IsGuest: true,
	}}
	r, _ := newTestQuotaResolver(t, fetcher)

	d := r.CheckAndLock(quotaCtx("req-1"), "", "9.9.9.9", "", 100)
	if d.Allowed {
		t.Fatal("expected rejection (450+100 > 500)")
	}
	if d.Code != "GUEST_BANDWIDTH_LIMIT" {
		t.Errorf("code: got %q, want GUEST_BANDWIDTH_LIMIT", d.Code)
	}
}

func TestQuota_NoSubject_AllowsWithoutFetch(t *testing.T) {
	fetcher := &fakeQuotaFetcher{resp: &pb.GetBandwidthQuotaResponse{}}
	r, _ := newTestQuotaResolver(t, fetcher)

	// No userID and no ip (e.g. S3 public) → nothing to enforce.
	d := r.CheckAndLock(quotaCtx("req-1"), "", "", "", 100)
	if !d.Allowed {
		t.Fatal("expected allowed when no subject")
	}
	if fetcher.callCount != 0 {
		t.Errorf("gRPC calls: got %d, want 0", fetcher.callCount)
	}
}

func TestQuota_FailOpen_OnGrpcError(t *testing.T) {
	fetcher := &fakeQuotaFetcher{err: context.DeadlineExceeded}
	r, _ := newTestQuotaResolver(t, fetcher)

	// gRPC down on a cache miss → allow rather than block.
	d := r.CheckAndLock(quotaCtx("req-1"), "user-1", "", "", 100)
	if !d.Allowed {
		t.Fatal("expected fail-open (allow) when gRPC errors")
	}
}

// Guest usage accumulates only in Redis (NestJS never gets guest reports), so a
// refetch must NOT overwrite the in-flight hash value with the stale DB value.
func TestQuota_GuestAccumulation_PreservedAcrossRefetch(t *testing.T) {
	reset := nowISO(1)
	// DB always reports 0 used (guest row never updated by Go); same reset window.
	fetcher := &fakeQuotaFetcher{resp: &pb.GetBandwidthQuotaResponse{
		DailyUsed: 0, DailyLimit: 1000, LastReset: reset, IsGuest: true,
	}}
	r, mr := newTestQuotaResolver(t, fetcher)

	// First request seeds (0) and locks +400 → 400.
	r.CheckAndLock(quotaCtx("r1"), "", "9.9.9.9", "", 400)
	// Force a refetch by clearing then... actually a fileId is needed to refetch,
	// but guests rarely carry one. Simulate the boundary case directly: the hash
	// exists, so the next no-file call is a pure cache hit (no refetch) — assert
	// the locked value persisted rather than being reset to the DB's 0.
	got, _ := strconv.ParseInt(mr.HGet(guestQuotaCacheKey("9.9.9.9"), "dailyBandwidthUsed"), 10, 64)
	if got != 400 {
		t.Fatalf("after first lock: got %d, want 400", got)
	}

	// Second request (with fileId → forces refetch path through reconcileHash).
	r.CheckAndLock(quotaCtx("r2"), "", "9.9.9.9", "file-x", 300)
	got, _ = strconv.ParseInt(mr.HGet(guestQuotaCacheKey("9.9.9.9"), "dailyBandwidthUsed"), 10, 64)
	// Must preserve accumulated 400 then lock +300 → 700 (NOT reset to DB 0 +300).
	if got != 700 {
		t.Errorf("after refetch+lock: got %d, want 700 (accumulation preserved)", got)
	}
}

// A rolled-over 24h window (server reset newer than cached) must reset usage.
func TestQuota_WindowRollover_ResetsUsage(t *testing.T) {
	r, mr := newTestQuotaResolver(t, &fakeQuotaFetcher{})

	key := userQuotaKey("user-1")
	// Pre-seed a stale hash from a previous window with high usage.
	oldReset := nowISO(30) // 30h ago → window expired
	mr.HSet(key, "dailyBandwidthUsed", "5000")
	mr.HSet(key, "dailyBandwidthLimit", "10000")
	mr.HSet(key, "lastBandwidthReset", oldReset)

	// Server reports the new window (reset now, used 0). Use a fileId to force the
	// refetch/reconcile path.
	newReset := nowISO(0)
	r.core = &fakeQuotaFetcher{resp: &pb.GetBandwidthQuotaResponse{
		DailyUsed: 0, DailyLimit: 10000, LastReset: newReset,
	}}

	d := r.CheckAndLock(quotaCtx("r1"), "user-1", "", "file-1", 100)
	if !d.Allowed {
		t.Fatalf("expected allowed after rollover, got %+v", d)
	}
	got, _ := strconv.ParseInt(mr.HGet(key, "dailyBandwidthUsed"), 10, 64)
	// Reset to DB 0 then lock +100 → 100 (NOT 5000+100).
	if got != 100 {
		t.Errorf("after rollover: got %d, want 100 (usage reset)", got)
	}
}

func TestQuota_Singleflight_CollapsesConcurrentMisses(t *testing.T) {
	fetcher := &fakeQuotaFetcher{
		resp:  &pb.GetBandwidthQuotaResponse{DailyUsed: 0, DailyLimit: 1 << 40, LastReset: nowISO(1)},
		delay: 50 * time.Millisecond,
	}
	r, _ := newTestQuotaResolver(t, fetcher)

	const goroutines = 20
	var wg sync.WaitGroup
	wg.Add(goroutines)
	for i := 0; i < goroutines; i++ {
		go func() {
			defer wg.Done()
			_ = r.CheckAndLock(quotaCtx("req"), "user-same", "", "", 1)
		}()
	}
	wg.Wait()

	if got := atomic.LoadInt64(&fetcher.callCount); got != 1 {
		t.Errorf("gRPC calls: got %d, want 1 (singleflight collapse)", got)
	}
}
