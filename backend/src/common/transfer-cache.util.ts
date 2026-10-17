import * as crypto from 'crypto';

/**
 * CDN-cache headers for the data plane (download / stream responses).
 *
 * Mirrors `backend-transfer-go/internal/telegram/cacheheaders.go` — both sides
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
 *    share token) → the only scope a CDN may cache.
 *  - "private": URL has NO per-request credential (owner JWT/cookie routes) →
 *    always `private, no-store`; the CDN must bypass.
 *
 * Modes (settings key `CDN_CACHE_MODE`, default `disabled`):
 *  - disabled: every scope → explicit `Cache-Control: private, no-store` so
 *    CDNs never guess; behavior unchanged until an admin opts in.
 *  - revalidate: signed → `no-cache` (store + revalidate every hit). Every CDN
 *    hit consults the origin; the origin grants a 304 only after the quota
 *    pass, and a revalidation 304 counts as a download (downloads24h moves)
 *    while the daily-bandwidth lock is refunded in full.
 *  - full: signed → `public, max-age=<TTL>` — CDN hits are NOT metered inside
 *    the TTL window (bandwidth/quota undercount accepted).
 */
export type TransferCacheScope = 'signed' | 'private';
export type TransferCacheMode = 'disabled' | 'revalidate' | 'full';

export interface TransferCacheDirectories {
  mode: TransferCacheMode;
  ttlSeconds: number;
}

export const TRANSFER_CACHE_MODE_KEY = 'CDN_CACHE_MODE';
export const TRANSFER_CACHE_TTL_KEY = 'CDN_CACHE_TTL_SECONDS';

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
  const etag = transferCacheETag(fileId, size);
  if (scope === 'private' || dirs.mode === 'disabled') {
    return { 'Cache-Control': 'private, no-store', ETag: etag };
  }
  if (dirs.mode === 'revalidate') {
    return { 'Cache-Control': 'no-cache', ETag: etag };
  }
  return {
    'Cache-Control': `public, max-age=${clampTransferCacheTtl(dirs.ttlSeconds)}`,
    ETag: etag,
  };
}

export const TRANSFER_CACHE_WINDOW_KEY = 'CDN_CACHE_WINDOW_SECONDS';

/**
 * P1: raw exp = now + ttl mints a fresh token per second, so every signed-URL
 * request produces a different value and the CDN cache key churns. Quantize
 * the absolute exp to the window bucket: two URLs minted inside the same
 * window share the token string (and therefore the same cache key). Cost: the
 * token lives up to W-1 s beyond the nominal TTL. Only applied when the CDN
 * cache mode is not 'disabled'.
 */
export function quantizeTokenExp(
  expSeconds: number,
  windowSeconds: number,
): number {
  const w = Number.isFinite(windowSeconds) ? Math.floor(windowSeconds) : 0;
  if (w <= 0) return expSeconds;
  return Math.ceil(expSeconds / w) * w;
}
