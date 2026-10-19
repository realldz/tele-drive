/**
 * Client-facing runtime config helpers.
 *
 * The frontend used to bake these values at build time
 * (`NEXT_PUBLIC_TRANSFER_URL`, `NEXT_PUBLIC_S3_DOMAIN`). They are now served at
 * runtime by `GET /client-config` so a deploy can enable/disable the dedicated
 * transfer + S3 domains without rebuilding the frontend image.
 */

/**
 * The S3 host placeholder every compose service and the Go data plane default
 * to when the operator never set `S3_DOMAIN` (see `docker-compose*.yml`,
 * `backend/src/s3/s3.controller.ts`, `backend-transfer-go/internal/config`).
 *
 * The old frontend build arg was `${S3_DOMAIN:-}` (empty = unset), so a
 * placeholder host must NOT be advertised to clients as a usable endpoint —
 * the keys page has to keep showing `s3.endpointUnconfigured`.
 */
export const S3_DOMAIN_PLACEHOLDER = 's3.example.com';

/**
 * Resolves the S3 host to advertise to clients, or `null` when S3 is not
 * actually configured.
 *
 * Accepts a bare host (`s3.example.com`) or an origin (`https://s3.example.com`;
 * the legacy frontend normalized both). The placeholder host — with or without
 * scheme/trailing slash, any casing — counts as unconfigured.
 */
export function getPublicS3Domain(): string | null {
  const raw = (process.env.S3_DOMAIN || '').trim().replace(/\/+$/, '');
  if (!raw) return null;
  const host = raw.replace(/^https?:\/\//i, '').toLowerCase();
  if (host === S3_DOMAIN_PLACEHOLDER) return null;
  return raw;
}
