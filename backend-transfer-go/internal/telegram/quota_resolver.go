// Package telegram — bandwidth quota resolution for the data plane.
//
// QuotaResolver enforces all three quota tiers (user daily / guest-IP daily /
// per-file) for download + S3 GET, using a Redis-first, gRPC-fallback strategy
// that mirrors s3auth.CredentialResolver:
//
//	Redis HGETALL user:{userId}:quota  (or guest:{ip}:quota)
//	  ├─ HIT  → enforce from the cached hash
//	  └─ MISS → singleflight gRPC GetBandwidthQuota → HSET seed → enforce
//
// The Redis hash is the AUTHORITATIVE in-flight counter. NestJS owns the DB
// source of truth and is only consulted to seed the hash (on absence or after a
// 24h window roll-over). This matters for guests: Go never reports guest usage
// back to NestJS (the report RPC carries no IP), so the GuestTracker row never
// accumulates — only the Redis hash does. Overwriting it on every refetch would
// wipe that accumulation, so we preserve the hash value unless it is absent or
// the window reset.
//
// Fail-open: if the gRPC fetch errors (NestJS down), the request is ALLOWED so a
// control-plane outage never blocks downloads — matching the legacy behavior
// where a Redis miss allowed the request.
package telegram

import (
	"context"
	"fmt"
	"log/slog"
	"strconv"
	"time"

	pb "github.com/realldz/tele-drive/backend-transfer-go/internal/grpc/proto"
	"github.com/redis/go-redis/v9"
	"golang.org/x/sync/singleflight"
)

// quotaCtxKey is the context key type for the per-request correlation id, so
// resolver logs tie back to the edge access log (same pattern as s3auth).
type quotaCtxKey string

// quotaRequestIDKey carries the request id into CheckAndLock via context.
const quotaRequestIDKey quotaCtxKey = "requestId"

// quotaFetcher is the slice of the gRPC CoreClient the resolver needs. An
// interface keeps it unit-testable with a fake — *grpc.CoreClient satisfies it.
type quotaFetcher interface {
	GetBandwidthQuota(ctx context.Context, userID, ip, fileID string) (*pb.GetBandwidthQuotaResponse, error)
}

// quotaCacheTTL bounds how long a seeded quota hash lives before the next miss
// re-pulls from NestJS. 1h matches the legacy Expire in checkUserBandwidth.
const quotaCacheTTL = time.Hour

// QuotaDecision is the outcome of a quota check. When Allowed is false, Code +
// ResetAt describe which tier blocked and when it resets (for the 429 body).
type QuotaDecision struct {
	Allowed bool
	Code    string // USER_BANDWIDTH_LIMIT | GUEST_BANDWIDTH_LIMIT | FILE_DOWNLOAD_LIMIT | FILE_BANDWIDTH_LIMIT
	ResetAt string // ISO8601; empty when allowed
}

// QuotaResolver checks bandwidth quota with Redis caching + singleflight gRPC
// fallback. It also performs the optimistic lock (HIncrBy) on the daily tier.
type QuotaResolver struct {
	rdb     *redis.Client
	core    quotaFetcher
	logger  *slog.Logger
	sfGroup singleflight.Group
}

// NewQuotaResolver builds a resolver. logger must be non-nil; core is typically
// a *grpc.CoreClient.
func NewQuotaResolver(rdb *redis.Client, core quotaFetcher, logger *slog.Logger) *QuotaResolver {
	return &QuotaResolver{rdb: rdb, core: core, logger: logger}
}

// guestQuotaCacheKey namespaces the guest daily-quota hash. The user variant
// reuses userQuotaKey (user:{id}:quota), shared with NestJS syncUserBandwidth.
func guestQuotaCacheKey(ip string) string {
	return fmt.Sprintf("guest:%s:quota", ip)
}

// hashState is the current Redis daily-quota hash snapshot.
type hashState struct {
	exists    bool
	used      int64
	limit     int64
	lastReset string
}

// fileTierSnapshot holds the per-file quota values for one decision.
type fileTierSnapshot struct {
	downloads      int32
	downloadLimit  int32
	bandwidthUsed  int64
	bandwidthLimit int64
	resetAt        string
}

// CheckAndLock enforces the three quota tiers and, when allowed, optimistically
// locks the daily tier by HIncrBy(estimatedSize). Returns a QuotaDecision.
//
// userID empty → guest path keyed by ip. estimatedSize is the bytes this
// request intends to serve (range-aware). fileID drives the per-file tier.
func (r *QuotaResolver) CheckAndLock(ctx context.Context, userID, ip, fileID string, estimatedSize int64) QuotaDecision {
	reqID, _ := ctx.Value(quotaRequestIDKey).(string)

	isGuest := userID == ""
	cacheKey := userQuotaKey(userID)
	if isGuest {
		if ip == "" {
			// No subject at all (e.g. S3 public) — nothing to enforce against.
			return QuotaDecision{Allowed: true}
		}
		cacheKey = guestQuotaCacheKey(ip)
	}

	hs := r.readHash(ctx, cacheKey, reqID)

	// gRPC is needed when the hash is absent (seed) or a fileId is in play (the
	// per-file tier is never cached — always pulled fresh).
	var used, limit int64
	var resetAt string
	var fileTier *fileTierSnapshot

	if !hs.exists || fileID != "" {
		resp, ok := r.fetch(ctx, cacheKey, userID, ip, fileID, reqID)
		if !ok {
			// Fail-open: control plane unreachable — allow rather than block.
			r.logger.Warn("quota.fail_open", "userId", userID, "ip", ip, "fileId", fileID, "requestId", reqID)
			return QuotaDecision{Allowed: true}
		}
		limit = resp.DailyLimit
		used = r.reconcileHash(ctx, cacheKey, hs, resp, reqID)
		resetAt = computeResetAt(resp.LastReset)
		if fileID != "" {
			fileTier = &fileTierSnapshot{
				downloads:      resp.FileDownloads_24H,
				downloadLimit:  resp.FileDownloadLimit_24H,
				bandwidthUsed:  resp.FileBandwidthUsed_24H,
				bandwidthLimit: resp.FileBandwidthLimit_24H,
				resetAt:        computeResetAt(resp.FileLastDownloadReset),
			}
		}
	} else {
		// Pure cache hit (no fileId) — enforce straight from the hash.
		used, limit, resetAt = hs.used, hs.limit, computeResetAt(hs.lastReset)
		r.logger.Debug("quota.cache.hit", "key", cacheKey, "used", used, "limit", limit, "requestId", reqID)
	}

	// Tier 2 — per-file (checked before the daily lock so we never lock on a
	// request a per-file limit would reject anyway).
	if fileTier != nil {
		if fileTier.downloadLimit > 0 && fileTier.downloads >= fileTier.downloadLimit {
			r.logger.Info("quota.file_download_limit",
				"fileId", fileID, "downloads", fileTier.downloads, "limit", fileTier.downloadLimit, "requestId", reqID)
			return QuotaDecision{Allowed: false, Code: "FILE_DOWNLOAD_LIMIT", ResetAt: fileTier.resetAt}
		}
		if fileTier.bandwidthLimit > 0 && fileTier.bandwidthUsed+estimatedSize > fileTier.bandwidthLimit {
			r.logger.Info("quota.file_bandwidth_limit",
				"fileId", fileID, "used", fileTier.bandwidthUsed, "estimated", estimatedSize, "limit", fileTier.bandwidthLimit, "requestId", reqID)
			return QuotaDecision{Allowed: false, Code: "FILE_BANDWIDTH_LIMIT", ResetAt: fileTier.resetAt}
		}
	}

	// Tier 1/3 — daily user/guest bandwidth.
	if limit > 0 && used+estimatedSize > limit {
		code := "USER_BANDWIDTH_LIMIT"
		if isGuest {
			code = "GUEST_BANDWIDTH_LIMIT"
		}
		r.logger.Info("quota.daily_limit",
			"code", code, "userId", userID, "ip", ip, "used", used, "estimated", estimatedSize, "limit", limit, "requestId", reqID)
		return QuotaDecision{Allowed: false, Code: code, ResetAt: resetAt}
	}

	// Allowed → optimistic lock on the daily tier (refunded later if actual < estimated).
	r.rdb.HIncrBy(ctx, cacheKey, "dailyBandwidthUsed", estimatedSize)
	r.rdb.Expire(ctx, cacheKey, quotaCacheTTL)
	r.logger.Debug("quota.locked",
		"userId", userID, "ip", ip, "fileId", fileID, "estimated", estimatedSize, "used", used, "limit", limit, "requestId", reqID)

	return QuotaDecision{Allowed: true}
}

// readHash reads the daily-quota hash. exists=false means a clean miss.
func (r *QuotaResolver) readHash(ctx context.Context, cacheKey, reqID string) hashState {
	vals, err := r.rdb.HMGet(ctx, cacheKey, "dailyBandwidthUsed", "dailyBandwidthLimit", "lastBandwidthReset").Result()
	if err != nil {
		r.logger.Error("quota.cache.redis_error", "key", cacheKey, "error", err.Error(), "requestId", reqID)
		return hashState{}
	}
	if vals[0] == nil {
		return hashState{}
	}
	hs := hashState{exists: true, lastReset: asString(vals[2])}
	hs.used, _ = strconv.ParseInt(asString(vals[0]), 10, 64)
	if vals[1] != nil {
		hs.limit, _ = strconv.ParseInt(asString(vals[1]), 10, 64)
	}
	return hs
}

// fetch pulls the quota snapshot from NestJS, collapsing concurrent misses for
// the same key+file into one gRPC call. ok=false on gRPC error (caller fails open).
func (r *QuotaResolver) fetch(ctx context.Context, cacheKey, userID, ip, fileID, reqID string) (*pb.GetBandwidthQuotaResponse, bool) {
	r.logger.Info("quota.cache.miss", "key", cacheKey, "userId", userID, "ip", ip, "fileId", fileID, "requestId", reqID)

	v, ferr, shared := r.sfGroup.Do(cacheKey+"|"+fileID, func() (interface{}, error) {
		return r.core.GetBandwidthQuota(ctx, userID, ip, fileID)
	})
	if shared {
		r.logger.Debug("quota.singleflight.shared", "key", cacheKey, "fileId", fileID, "requestId", reqID)
	}
	if ferr != nil {
		r.logger.Error("quota.grpc.error", "key", cacheKey, "error", ferr.Error(), "requestId", reqID)
		return nil, false
	}
	resp := v.(*pb.GetBandwidthQuotaResponse)
	r.logger.Info("quota.grpc.fetched",
		"key", cacheKey, "dbUsed", resp.DailyUsed, "limit", resp.DailyLimit, "isGuest", resp.IsGuest, "fileId", fileID, "requestId", reqID)
	return resp, true
}

// reconcileHash seeds / refreshes the daily hash from a gRPC response and returns
// the authoritative `used` to enforce against. It seeds `used` from the DB only
// when the hash is absent or the 24h window rolled over (server lastReset newer
// than the cached one); otherwise it preserves the accumulated in-flight value
// and only refreshes the limit + reset marker. Seed errors are non-fatal.
func (r *QuotaResolver) reconcileHash(ctx context.Context, cacheKey string, hs hashState, resp *pb.GetBandwidthQuotaResponse, reqID string) int64 {
	used := resp.DailyUsed
	fields := map[string]interface{}{
		"dailyBandwidthLimit": strconv.FormatInt(resp.DailyLimit, 10),
		"lastBandwidthReset":  resp.LastReset,
	}

	if !hs.exists || windowRolledOver(hs.lastReset, resp.LastReset) {
		// Fresh seed from DB.
		fields["dailyBandwidthUsed"] = strconv.FormatInt(used, 10)
	} else {
		// Preserve accumulated in-flight usage (esp. guests, whose DB row Go never updates).
		used = hs.used
	}

	if err := r.rdb.HSet(ctx, cacheKey, fields).Err(); err != nil {
		r.logger.Error("quota.cache.seed_error", "key", cacheKey, "error", err.Error(), "requestId", reqID)
	} else {
		r.rdb.Expire(ctx, cacheKey, quotaCacheTTL)
	}
	return used
}

// windowRolledOver reports whether the server's reset timestamp is newer than the
// cached one, meaning a 24h window boundary passed and usage should reset.
func windowRolledOver(cachedReset, serverReset string) bool {
	if cachedReset == "" || serverReset == "" {
		return false
	}
	ct, e1 := time.Parse(time.RFC3339, cachedReset)
	st, e2 := time.Parse(time.RFC3339, serverReset)
	if e1 != nil || e2 != nil {
		return false
	}
	return st.After(ct)
}

// computeResetAt returns lastReset + 24h (ISO8601) for the 429 body. Empty when
// lastReset is missing or unparseable.
func computeResetAt(lastReset string) string {
	if lastReset == "" {
		return ""
	}
	t, err := time.Parse(time.RFC3339, lastReset)
	if err != nil {
		return ""
	}
	return t.Add(24 * time.Hour).UTC().Format(time.RFC3339)
}

// asString coerces a Redis HMGet value (interface{}) to string.
func asString(v interface{}) string {
	if s, ok := v.(string); ok {
		return s
	}
	return ""
}
