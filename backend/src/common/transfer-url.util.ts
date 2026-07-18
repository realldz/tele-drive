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
  const base = process.env.PUBLIC_TRANSFER_URL;
  if (!base) return path;
  return `${base.replace(/\/+$/, '')}${path}`;
}
