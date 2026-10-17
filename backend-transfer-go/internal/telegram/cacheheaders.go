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
//     share token) → the only scope a CDN may cache.
//     private: URL has NO per-request credential (owner JWT / stream-cookie
//     routes) → always `private, no-store`; the CDN must bypass.
//   - none: skip entirely — routes with their own ETag semantics (S3 GetObject
//     carries the real object ETag; a td- ETag would clobber it).
//
// Modes (settings key CDN_CACHE_MODE, default `disabled`):
//   - disabled: every scope → `private, no-store` (explicit, so CDNs never
//     guess). No behavior change until an admin opts in.
//   - revalidate: signed → `no-cache` (store + revalidate every hit). Every
//     CDN hit consults the origin; the origin grants a 304 only after the
//     quota pass, and a revalidation 304 reports actualBytes=0 with
//     CountDownload=true so downloads24h counts it while the daily-bandwidth
//     lock is fully refunded.
//   - full: signed → `public, max-age=<CDN_CACHE_TTL_SECONDS>` — CDN hits are
//     NOT metered inside the TTL window (bandwidth/quota undercount accepted).
type DownloadCacheScope string

const (
	CacheScopeSigned  DownloadCacheScope = "signed"
	CacheScopePrivate DownloadCacheScope = "private"
	CacheScopeNone    DownloadCacheScope = "none"
)

type DownloadCacheMode string

const (
	CacheModeDisabled   DownloadCacheMode = "disabled"
	CacheModeRevalidate DownloadCacheMode = "revalidate"
	CacheModeFull       DownloadCacheMode = "full"
)

const (
	cacheModeSettingKey = "CDN_CACHE_MODE"
	cacheTTLSettingKey  = "CDN_CACHE_TTL_SECONDS"
	cacheDefaultTTL     = 3600
	cacheMinTTL         = 30
	cacheMaxTTL         = 7 * 24 * 60 * 60

	policyNoStore    = "private, no-store"
	policyRevalidate = "no-cache"
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

func (d *Downloader) cdnCacheConfig(ctx context.Context) (DownloadCacheMode, int) {
	if d.settingsResolver == nil {
		return CacheModeDisabled, cacheDefaultTTL
	}
	raw := strings.ToLower(strings.TrimSpace(
		d.settingsResolver.GetString(ctx, cacheModeSettingKey, string(CacheModeDisabled))))
	mode := DownloadCacheMode(raw)
	switch mode {
	case CacheModeRevalidate, CacheModeFull:
	default:
		mode = CacheModeDisabled
	}
	return mode, clampCacheTTL(d.settingsResolver.GetInt(ctx, cacheTTLSettingKey, cacheDefaultTTL))
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
// (the caller must then stream nothing). Enabled only for the `signed` scope —
// URLs without a per-request credential must never be cached by a CDN.
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

	mode, ttl := d.cdnCacheConfig(ctx)
	var policy string
	if scope == CacheScopeSigned && mode != CacheModeDisabled {
		if mode == CacheModeFull {
			policy = "public, max-age=" + strconv.Itoa(ttl)
		} else {
			policy = policyRevalidate
		}
	} else {
		policy = policyNoStore
	}
	etag := transferCacheETag(fileID, size)

	w.Header().Set("Cache-Control", policy)
	w.Header().Set("ETag", etag)

	if d.logger != nil {
		d.logger.Debug("cache headers applied",
			"fileId", fileID,
			"scope", string(scope),
			"mode", string(mode),
			"policy", policy,
		)
	}

	if policy != policyNoStore && ifNoneMatchSatisfied(ifNoneMatch, etag) {
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

