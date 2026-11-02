# Folder deletion performance and frontend feedback

## Implementation plan and scope (2026-11-02)

1. Replace per-folder soft-delete queries with one PostgreSQL statement; retain ownership, older trash, and restore timestamps.
2. Collect hard-delete file IDs with a recursive CTE, then process bounded metadata/cleanup batches.
3. Give dashboard/trash mutations immediate pending feedback, duplicate-submit protection, progress, partial failure handling, and correct search refresh.
4. Cover SQL behavior with embedded PostgreSQL and frontend hooks with Vitest; run package lint/typecheck/build and independent code review.

All four steps are implemented. Permanent folder deletion remains a synchronous HTTP operation. No durable job/status API is introduced here.

## Soft delete

`DELETE /folders/:id` returns the existing folder fields plus `deletedFolderIds`. After verifying the root owner, `folder-deletion-queries.ts` executes a recursive CTE over active descendants owned by that user. Two data-modifying CTEs mark files and folders in the same atomic PostgreSQL statement. There are two application DB calls regardless of subtree size: root lookup and tree update. The database still updates every affected row; this removes application round trips, not row-update work. Response size scales with folder count, not file count.

- All newly trashed items share one JavaScript millisecond timestamp. `updatedAt` is explicitly maintained because raw SQL bypasses Prisma's `@updatedAt` handling.
- Already trashed files and entire already trashed subtrees are skipped. Restore continues to match `deletedAt`, so old trash is not accidentally restored with its parent.
- Storage quota, chunks, Telegram objects, and download accounting are unchanged by soft delete.
- Counts and elapsed milliseconds are logged. A database failure rolls back the entire statement.
- Added indexes: `Folder(parentId, deletedAt)` and `FileRecord(folderId, deletedAt)`. Apply the schema with the normal `npx prisma db push && npx prisma generate` deployment flow. No live database was modified during development.

## Permanent folder deletion

The recursive collection query includes active and trashed descendants and filters by owner. Metadata and chunks are fetched in batches of at most 200 files; the full ID list is still held in memory.

- Legacy HTTP purge sends one batch instead of one request per file. Existing Telegram deletion remains best-effort.
- Event-driven mode retains the existing Redis Stream event protocol and publication failure behavior; event sends are still sequential within each batch.
- Each metadata deletion and quota decrement is a transaction. `DELETE ... RETURNING size, status` computes freed storage from rows actually removed, avoiding duplicate quota decrement for overlapping bulk calls.
- Earlier successful batches stay committed if a later batch fails. The folder is removed only after all batches finish; retry collects remaining files.
- Disabled CDN purge does not query ancestor paths. Enabled purge resolves public prefixes once per folder within each batch.
- Individual file deletion, manual empty-trash worker, cron cleanup, and Go deletion-event payloads retain their existing implementation.

This is not a cross-client subtree write lock. Uploads/moves concurrent with deletion from other clients still need coordination at the backend write boundary in a future change. The frontend blocks local move/drop actions during deletion.

## Frontend behavior

- `use-item-actions` owns a synchronous ref lock, pending IDs, progress toast, successful-row removal, and aggregated outcome. It prevents duplicate requests before React renders.
- Only confirmed successes leave the current list. On partial failure, the list is not reset to page one, so failed items on later loaded pages remain visible and selected for retry.
- Single dashboard deletion (including a one-item toolbar selection) offers Undo after success. API errors no longer use the stuck-upload error label.
- Dashboard uses the displayed search dataset for action types and refreshes search on successful completion. `resolveDeletionTargets` resolves ancestor overlap before any deletion and shares one root request across selected descendants, including paths omitted from search results.
- `deletedFolderIds` also removes unselected visible descendant folders/files after a folder succeeds. This prevents stale search rows when an unrelated item fails and the UI preserves the loaded pages for retry.
- Pending rows show a moving-to-trash indicator. Destructive controls and drag/drop mutations are disabled for the operation.
- Trash batch cancellation keeps selection; partial failures preserve failed selection. Batch confirmation refers to selected items, not the whole trash.
- Cleanup status is checked on page entry, then polled only while cleaning or recovering from a status error. The initial lookup and in-progress state gate conflicting actions; a failed lookup has a visible retry banner. `accepted:false` does not start a fake cleanup. Completion clears pending state and refreshes the list. Poll failures do not imply completion.
- A failed cleanup-start POST may have been accepted before the connection failed. Mutations remain blocked until a follow-up status lookup resolves that ambiguity.
- Progress counts selected items, not files inside a selected folder; the existing API does not report intra-folder progress.

## Verification

- Backend: `npm test -- src/folder/folder-deletion-queries.spec.ts src/file/file-lifecycle.service.spec.ts src/folder/folder.controller.spec.ts src/common/trash-cleanup.service.spec.ts --runInBand`.
- SQL tests use PGlite (PostgreSQL in WASM), including owner isolation, prior-trash preservation, timestamp restore grouping, duplicate delete, statement rollback, and 1,002 active folders / 5,002 active files in one query. Its timestamp parser is configured to match Prisma UTC semantics.
- Jest's test script enables VM modules for PGlite's dynamic imports. No real database, credentials, Redis, or Telegram is required for these tests.
- Frontend: `npm test`, `npm run lint`, `npx tsc -p tsconfig.json --noEmit`, `npm run build`. Hook tests exercise duplicate submission, partial failure, search folder routing, parent/descendant overlap, cleanup discovery/completion, empty cleanup, and status retry.
- Whole-backend lint has pre-existing errors outside this change; new backend query/test files are linted separately. These tests do not establish production latency or validate distributed concurrent uploads/deletions.

`docs/` is ignored by this repository; include this note explicitly when preparing a commit.
