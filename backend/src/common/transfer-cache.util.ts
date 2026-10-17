import * as crypto from 'crypto';

/**
 * CDN-cache headers for the data plane (download / stream responses).
 *
 * Mirrors `backend-transfer-go/internal/handler/cacheheaders.go` — both sides
 * must emit the SAME ETag for the same (fileId, size) because either backend
 * may serve the origin fetch the CDN revalidates against.
 *
 * Content immutability assumption: a fileId's bytes are immutable once
 * `complete` (soft-delete keeps the URL unresolvable at origin; overwrite moves
 * the old version to trash and creates a NEW fileId → new cache key). That is
 * why the fingerprint only needs (fileId, size).
 *
 * Scopes:
 *  - "signed": URL carries its own bearer credential (signed download token,
 *    share token) → cacheable with `public, max-age=<ttl>` when enabled.
 *  - "private": URL has NO per-request credential (owner JWT/cookie routes) →
 *    always `private, no-store`; the CDN must bypass.
 *
 * When `CDN_CACHE_ENABLED` is false (default) every scope still emits an
 * explicit `Cache-Control: private, no-store` so CDNs never guess.
 */
export type TransferCacheScope = 'signed' | 'private';

export interface TransferCacheDirectories {
  enabled: boolean;
  ttlSeconds: number;
}

export const TRANSFER_CACHE_TTL_KEY = 'CDN_CACHE_TTL_SECONDS';
export const TRANSFER_CACHE_ENABLED_KEY = 'CDN_CACHE_ENABLED';

/** Guard against absurd values slipping in through the settings table. */
export const TRANSFER_CACHE_MIN_TTL = 30;
export const TRANSFER_CACHE_MAX_TTL = 7 * 24 * 60 * 60;

export function clampTransferCacheTtl(raw: number): number {
  if (!Number.isFinite(raw) || raw <= 0) return 3600;
  return Math.min(
    Math.max(Math.floor(raw), TRANSFER_CACHE_MIN_TTL),
    TRANSFER_CACHE_MAX_TTL,
  );
}

/**
 * ETag both backends must agree on. sha256(fileId + ':' + size), hex-trimmed —
 * strong validator (content per fileId is immutable; see doc above).
 */
export function transferCacheETag(
  fileId: string,
  size: number | string | bigint,
): string {
  const fingerprint = crypto
    .createHash('sha256')
    .update(`${fileId}:${size.toString()}`)
    .digest('hex')
    .slice(0, 32);
  return `"td-${fingerprint}"`;
}

/** RFC 7232 If-None-Match matcher: `*`, exact, and comma-separated lists, weak-prefix tolerant. */
export function ifNoneMatchSatisfied(
  ifNoneMatch: string | undefined,
  etag: string,
): boolean {
  if (!ifNoneMatch) return false;
  const candidate = etag.replace(/^W\//, '');
  for (const raw of ifNoneMatch.split(',')) {
    const candidateHeader = raw.trim().replace(/^W\//, '');
    if (candidateHeader === '*' || candidateHeader === candidate) return true;
  }
  return false;
}

/** Response headers for a NON-conditional response. `private` scope ignores settings. */
export function computeTransferCacheHeaders(
  scope: TransferCacheScope,
  dirs: TransferCacheDirectories,
  fileId: string,
  size: bigint | number,
): { 'Cache-Control': string; ETag: string } {
  if (scope === 'private' || !dirs.enabled) {
    return {
      'Cache-Control': 'private, no-store',
      ETag: transferCacheETag(fileId, size),
    };
  }
  return {
    'Cache-Control': `public, max-age=${clampTransferCacheTtl(dirs.ttlSeconds)}`,
    ETag: transferCacheETag(fileId, size),
  };
}
