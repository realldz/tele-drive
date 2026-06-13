// Package settings — admin-dashboard SystemSetting resolution for the data plane.
//
// Resolver fetches the SystemSetting table from NestJS over gRPC and caches the
// whole map in-memory with a short TTL, so admin-dashboard changes propagate to
// the Go service without a redeploy (matching NestJS getCachedSetting's 30s
// cache; we use a slightly longer 60s window since these values are low-churn).
//
//	in-memory map (fresh)  → serve from cache
//	in-memory map (stale)  → singleflight gRPC GetSystemSettings → refresh → serve
//
// NestJS owns the source of truth (Postgres SystemSetting). The TTL bounds how
// long a change waits before the Go side sees it.
//
// Fail-soft: if the gRPC fetch errors (NestJS down) and a previous snapshot
// exists, the stale snapshot is served rather than reverting to defaults — a
// control-plane blip should not silently change enforcement. With no snapshot
// at all (cold start + NestJS down), typed getters return their caller-supplied
// default.
package settings

import (
	"context"
	"log/slog"
	"strconv"
	"sync"
	"time"

	"golang.org/x/sync/singleflight"
)

// settingsFetcher is the slice of the gRPC CoreClient this resolver needs.
// Declaring it as an interface keeps the resolver unit-testable with a fake
// (no live gRPC connection) — *grpc.CoreClient satisfies it directly.
type settingsFetcher interface {
	GetSystemSettings(ctx context.Context, keys []string) (map[string]string, error)
}

// cacheTTL bounds how long a fetched settings snapshot is served before the next
// access triggers a refresh. 60s keeps admin changes near-live without hammering
// NestJS on every download/upload.
const cacheTTL = 60 * time.Second

// Resolver resolves SystemSetting keys with an in-memory TTL cache and a
// singleflight-guarded gRPC refresh. Safe for concurrent use.
type Resolver struct {
	core    settingsFetcher
	logger  *slog.Logger
	sfGroup singleflight.Group

	mu       sync.RWMutex
	snapshot map[string]string // last good map; nil until first successful fetch
	expiry   time.Time
}

// NewResolver builds a Resolver. logger must be non-nil; core is typically a
// *grpc.CoreClient.
func NewResolver(core settingsFetcher, logger *slog.Logger) *Resolver {
	return &Resolver{core: core, logger: logger}
}

// snapshotIfFresh returns the cached map when still within the TTL window.
func (r *Resolver) snapshotIfFresh() (map[string]string, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	if r.snapshot != nil && time.Now().Before(r.expiry) {
		return r.snapshot, true
	}
	return r.snapshot, false
}

// current returns a usable settings map, refreshing from NestJS when the cache
// is stale. On a refresh error it falls back to the last good snapshot (possibly
// nil on cold start). The returned map must be treated as read-only.
func (r *Resolver) current(ctx context.Context) map[string]string {
	if snap, fresh := r.snapshotIfFresh(); fresh {
		return snap
	}

	// Collapse concurrent refreshes into one gRPC call.
	v, _, _ := r.sfGroup.Do("settings", func() (interface{}, error) {
		// Re-check under the singleflight: a sibling may have just refreshed.
		if snap, fresh := r.snapshotIfFresh(); fresh {
			return snap, nil
		}

		fetched, err := r.core.GetSystemSettings(ctx, nil)
		if err != nil {
			stale, _ := r.snapshotIfFresh()
			r.logger.Error("settings.grpc.error",
				"error", err.Error(), "servingStale", stale != nil)
			return stale, nil // fail-soft: serve stale (or nil on cold start)
		}

		r.mu.Lock()
		r.snapshot = fetched
		r.expiry = time.Now().Add(cacheTTL)
		r.mu.Unlock()

		r.logger.Debug("settings.grpc.refreshed", "count", len(fetched))
		return fetched, nil
	})

	if m, ok := v.(map[string]string); ok {
		return m
	}
	return nil
}

// GetString returns the raw value for key, or defaultValue when absent/empty.
func (r *Resolver) GetString(ctx context.Context, key, defaultValue string) string {
	m := r.current(ctx)
	if v, ok := m[key]; ok && v != "" {
		return v
	}
	return defaultValue
}

// GetInt parses key as a base-10 int, returning defaultValue on absence/parse
// error.
func (r *Resolver) GetInt(ctx context.Context, key string, defaultValue int) int {
	v, ok := r.current(ctx)[key]
	if !ok {
		return defaultValue
	}
	i, err := strconv.Atoi(v)
	if err != nil {
		r.logger.Warn("settings.parse.int_error", "key", key, "value", v, "error", err.Error())
		return defaultValue
	}
	return i
}

// GetInt64 parses key as a base-10 int64, returning defaultValue on absence/parse
// error.
func (r *Resolver) GetInt64(ctx context.Context, key string, defaultValue int64) int64 {
	v, ok := r.current(ctx)[key]
	if !ok {
		return defaultValue
	}
	i, err := strconv.ParseInt(v, 10, 64)
	if err != nil {
		r.logger.Warn("settings.parse.int64_error", "key", key, "value", v, "error", err.Error())
		return defaultValue
	}
	return i
}

// GetBool parses key with the same semantics as NestJS (`v !== 'false'` → true),
// returning defaultValue when the key is absent.
func (r *Resolver) GetBool(ctx context.Context, key string, defaultValue bool) bool {
	v, ok := r.current(ctx)[key]
	if !ok {
		return defaultValue
	}
	return v != "false"
}
