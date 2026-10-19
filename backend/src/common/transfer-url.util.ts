/**
 * Resolves the client-facing data-plane origin.
 *
 * `PUBLIC_TRANSFER_URL` (e.g. `https://transfer.example.com`) is the single
 * source of truth for the dedicated transfer domain: NestJS prefixes it onto
 * emitted data-plane URLs, and the frontend fetches it at boot through
 * `GET /client-config` (see `client-config.controller.ts`) instead of baking
 * `NEXT_PUBLIC_TRANSFER_URL` into the bundle.
 *
 * Returns `null` when unset/blank (or nothing but slashes) so callers can fall
 * back to their legacy same-origin behavior. Reads env on each call so runtime
 * config changes are honored.
 */
export function getPublicTransferOrigin(): string | null {
  const base = process.env.PUBLIC_TRANSFER_URL;
  if (!base) return null;
  const normalized = base.replace(/\/+$/, '');
  return normalized || null;
}

/**
 * Builds a client-facing data-plane URL.
 *
 * When `PUBLIC_TRANSFER_URL` is set (e.g. `https://transfer.example.com`), the
 * given absolute path is prefixed with that origin so download/stream links
 * point at the dedicated transfer domain. When unset/empty, the path is
 * returned unchanged (relative) — byte-for-byte the legacy behavior where the
 * frontend prefixes `API_URL`.
 *
 * The `path` keeps its edge-facing shape (`/files/...`, `/transfer/...`); the
 * transfer-domain nginx rewrites it to the real Go route (Phase 4). Do not
 * rewrite to `/v1/transfer` here.
 *
 * Pure function — no side effects, reads env on each call so runtime config
 * changes are honored.
 */
export function buildTransferUrl(path: string): string {
  const origin = getPublicTransferOrigin();
  if (!origin) return path;
  return `${origin}${path}`;
}
