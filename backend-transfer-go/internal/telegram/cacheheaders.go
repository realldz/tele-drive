package telegram

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/http"
	"strconv"
	"strings"
)

// CDN-cache headers for the data plane (download / stream responses).
//
// Mirrors backend/src/common/transfer-cache.util.ts — both sides must emit the
// SAME ETag for the same (fileId, size) because either backend may serve the
// origin fetch the CDN revalidates against.
//
// Content immutability assumption: a fileId's bytes are immutable once
// "complete" (soft-delete keeps the token unresolvable at origin; overwrite
// moves the old version to trash and creates a NEW fileId → new cache key).
//
// Scopes:
//   - signed: URL carries its own bearer credential (signed download token,
//     share token) → cacheable with `public, max-age=<ttl>` when enabled.
//   - private: URL has NO per-request credential (owner JWT / stream-cookie
//     routes) → always `private, no-store`; the CDN must bypass.
//
// When CDN_CACHE_ENABLED is false (default) every byte response still gets an
// explicit `Cache-Control: private, no-store` so CDNs never guess.
type DownloadCacheScope string

const (
	CacheScopeSigned  DownloadCacheScope = "signed"
	CacheScopePrivate DownloadCacheScope = "private"
	// CacheScopeNone skips CDN-cache handling entirely — for routes with their
	// own ETag semantics (S3 GetObject carries the real object ETag; a td- ETag
	// would clobber it). P2 will add opt-in per-object cache policy there.
	CacheScopeNone DownloadCacheScope = "none"
)

const (
	cacheEnabledSettingKey = "CDN_CACHE_ENABLED"
	cacheTTLSettingKey     = "CDN_CACHE_TTL_SECONDS"
	cacheDefaultTTL        = 3600
	cacheMinTTL            = 30
	cacheMaxTTL            = 7 * 24 * 60 * 60
)

func clampCacheTTL(raw int) int {
	if raw <= 0 {
		return cacheDefaultTTL
	}
	if raw < cacheMinTTL {
		return cacheMinTTL
	}
	if raw > cacheMaxTTL {
		return cacheMaxTTL
	}
	return raw
}

func (d *Downloader) cdnCacheDirectories(ctx context.Context) (bool, int) {
	if d.settingsResolver == nil {
		return false, cacheDefaultTTL
	}
	enabled := d.settingsResolver.GetBool(ctx, cacheEnabledSettingKey, false)
	ttl := d.settingsResolver.GetInt(ctx, cacheTTLSettingKey, cacheDefaultTTL)
	return enabled, clampCacheTTL(ttl)
}

// transferCacheETag must match transferCacheETag() in transfer-cache.util.ts:
// sha256(fileId + ":" + size), first 32 hex chars, "td-" prefix, quoted.
func transferCacheETag(fileID string, size int64) string {
	sum := sha256.Sum256([]byte(fmt.Sprintf("%s:%d", fileID, size)))
	return `"` + "td-" + hex.EncodeToString(sum[:])[:32] + `"`
}

// ifNoneMatchSatisfied implements the RFC 7232 If-None-Match matcher: `*`,
// exact match, comma-separated lists, tolerant of a weak `W/` prefix.
func ifNoneMatchSatisfied(ifNoneMatch, etag string) bool {
	if ifNoneMatch == "" {
		return false
	}
	trimmedETag := strings.TrimPrefix(etag, "W/")
	for _, raw := range strings.Split(ifNoneMatch, ",") {
		candidate := strings.TrimSpace(raw)
		candidate = strings.TrimPrefix(candidate, "W/")
		if candidate == "*" || candidate == trimmedETag {
			return true
		}
	}
	return false
}

// ApplyCacheHeaders sets ETag + Cache-Control for a byte response and reports
// whether a matching If-None-Match already closed the response with a bare 304
// (the caller must then stream nothing). The `private` scope ignores settings —
// those URLs carry no per-request credential, so a CDN must never cache them.
func (d *Downloader) ApplyCacheHeaders(
	ctx context.Context,
	w http.ResponseWriter,
	scope DownloadCacheScope,
	fileID string,
	size int64,
	ifNoneMatch string,
) bool {
	if fileID == "" || scope == CacheScopeNone {
		return false
	}

	enabled, ttl := d.cdnCacheDirectories(ctx)
	var policy string
	switch {
	case scope == CacheScopePrivate || !enabled:
		policy = "private, no-store"
	default:
		policy = "public, max-age=" + strconv.Itoa(ttl)
	}
	etag := transferCacheETag(fileID, size)

	w.Header().Set("Cache-Control", policy)
	w.Header().Set("ETag", etag)

	if d.logger != nil {
		d.logger.Debug("cache headers applied",
			"fileId", fileID,
			"scope", string(scope),
			"enabled", enabled,
			"policy", policy,
		)
	}

	if enabled && scope == CacheScopeSigned && ifNoneMatchSatisfied(ifNoneMatch, etag) {
		if d.logger != nil {
			d.logger.Debug("cache revalidation hit (304)",
				"fileId", fileID,
				"etag", etag,
			)
		}
		w.WriteHeader(http.StatusNotModified)
		return true
	}
	return false
}
