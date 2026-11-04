# Shared items view

Sidebar **"Đang chia sẻ" (Shared)** view lists everything the user is currently
sharing publicly and lets them manage each item inline (copy link, open, revoke).
Read-only listing on top of the existing share/unshare mutations — no new
mutation endpoints.

## What counts as "currently shared" (locked scope)

- **Folder** — `shareToken != null` **OR** `s3PublicAccess = true`
- **File** — `shareToken != null`

Both sides are `userId`-scoped and exclude soft-deleted rows (`deletedAt: null`).
Files are additionally status-filtered (`complete, uploading, buffered,
buffer_failed`), mirroring `getContent`.

## Endpoint

```
GET /folders/shared?cursor=&limit=
```

JWT-guarded (global guard). Declared **before** the `:id` param routes in
`folder.controller.ts` (same hazard as `@Get('search')`/`@Get('trash/list')`) so
`shared` is not captured as a folder id.

Returns the same base shape as `/folders/content` so the frontend can reuse the
dual-cursor pagination contract:

```jsonc
{
  "folders": [...], "files": [...],
  "nextFolderCursor": "base64|null",
  "nextFileCursor": "base64|null",
  "totalFolders": 0, "totalFiles": 0
}
```

Folder rows include `s3PublicAccess` (alongside `shareToken` / `visibility`) so
the frontend can distinguish a public-link folder from an S3-public-only folder.
Sort is `createdAt desc`.

The cursor is opaque to callers. A folder continuation carries the last folder
id and the already-delivered file position (or a files-complete marker). This
prevents the folder walk from restarting files at page one. The frontend sends
`includeTotals=false` on continuation requests and preserves its initial totals,
so the two count queries run only on the initial request while the endpoint keeps
totals enabled by default for backwards-compatible callers.

## Where-fragment (single source of truth)

`backend/src/folder/shared-items-where.ts` — two pure builders:

- `buildSharedFolderWhere(userId)` → `{ userId, deletedAt: null, OR: [{ shareToken: { not: null } }, { s3PublicAccess: true }] }`
- `buildSharedFileWhere(userId)` → `{ userId, deletedAt: null, status: { in: [...] }, shareToken: { not: null } }`

Extracted as pure functions (DB-free) so the filter contract is unit-tested in
`shared-items-where.spec.ts` (mirrors the `file-format-category` precedent).
`folder.service.ts` `listShared()` consumes them + the `getContent`/`searchAll`
dual-cursor decode/encode verbatim.

## Frontend

- `hooks/use-shared.ts` — sibling to `useTrash`. Owns folders/files + dual cursors,
  `fetchShared`, `loadMoreShared`, and `revoke`.
- `components/organisms/shared/shared-table.tsx` — folders then files as rows;
  badge (`Public link` / `S3 public`) + inline actions.
- `app/shared/page.tsx` — `/shared` route, custom header, empty state, load-more.
- `components/sidebar.tsx` — nav entry (`Share2` icon) between Home and Trash.

### Revoke branching (edit hazard)

Revoke disables every active public mechanism:

- item has `shareToken` → `unshareItem(type, id)` (drops the public link)
- folder has `s3PublicAccess = true` → `setS3PublicAccess(id, false)`
- a folder with **both** toggles runs both mutations together

Copy-link and Open are **token-gated** — an S3-public-only folder has no share
page, so it shows only the S3 badge + revoke (no copy, no open).

Revoke reconciles the two settled mutations locally. A fully private item is
removed and its total decremented without resetting loaded pages. On partial
folder revoke, only the mechanism confirmed successful is cleared; the row
remains visible through the still-public mechanism and an error toast explains
the partial failure.

### Request lifecycle (edit hazard)

`useShared` waits for the auth token: `/shared` refetches when the token-backed
`fetchShared` callback changes, so direct loads cannot get stuck empty before auth
restoration. A monotonic `requestSeq` drops stale load-more responses after a
refresh; refresh also clears `loadingMore`. Revoke does not refresh the list: it
reconciles the settled mutations against the loaded rows and keeps both cursor
positions intact. Initial fetch failures render a retry state; load-more failures
toast; revoke errors toast and retain every mechanism not confirmed revoked.

For a folder with both a token **and** S3 public access, revoke waits for both
mutations (`Promise.allSettled`) and applies each result independently. Retry
remains safe because only the mechanism that is still active is called again.

The initial response totals drive the header; loaded array lengths are used only
for loading/empty rendering. The fetch callback reads translations through a ref,
so switching locale re-renders labels without issuing another list request or
collapsing pagination.

Auth restoration validates the cached token/user pair before installing it. A
malformed or incomplete cached user clears both values and finishes loading as
signed out instead of throwing during hydration.

## Edit hazards

- **Route order:** keep `@Get('shared')` before `@Get(':id/...')` routes.
- **Filter is the single source of truth** (`shared-items-where.ts`). If the
  "shared" definition changes, update the builders + the spec — do not inline a
  divergent `where` in `listShared`.
- **S3-public-only folder** has no `shareToken`: copy/open hidden, revoke → S3-off.
- **Cursors** are opaque snapshots. Preserve folder position plus file position
  or files-complete state when changing the payload. Old `{f, fc}` cursors remain
  valid. Callers that set `includeTotals=false` must preserve initial totals.
- **No new mutations** — reuses `unshareItem` / `setS3PublicAccess`. `getContent`
  and the recipient-side `share/:token` views are untouched.

## Perf note (upgrade path)

The initial endpoint request runs two list queries + two count queries. Folder-
only continuation pages run one list query; file continuation begins from the
file position carried by the folder token. Current schema has no query-specific
indexes for the folder `OR` (`shareToken` / `s3PublicAccess`) or file share
predicate. If measured latency rises, run `EXPLAIN ANALYZE`, then add partial/
index support for owner + active + shared + `createdAt desc` predicates. Do not
add indexes speculatively.
