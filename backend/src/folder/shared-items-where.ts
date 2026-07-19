import type { Prisma } from '@prisma/client';

/**
 * Where-fragment builders for the "currently shared" view (GET /folders/shared).
 *
 * Locked scope:
 *  - Folder is shared when `shareToken` is set OR `s3PublicAccess` is on.
 *  - File is shared when `shareToken` is set.
 *
 * Both sides are userId-scoped and exclude soft-deleted rows. Extracted as pure
 * functions so the filter contract is unit-testable without a DB (mirrors the
 * `file-format-category` precedent).
 */

const FILE_VISIBLE_STATUSES = [
  'complete',
  'uploading',
  'buffered',
  'buffer_failed',
] as const;

/** Folders owned by `userId` that are publicly shared via link OR S3 public access. */
export function buildSharedFolderWhere(
  userId: string,
): Prisma.FolderWhereInput {
  return {
    userId,
    deletedAt: null,
    OR: [{ shareToken: { not: null } }, { s3PublicAccess: true }],
  };
}

/** Files owned by `userId` that are publicly shared via link. */
export function buildSharedFileWhere(
  userId: string,
): Prisma.FileRecordWhereInput {
  return {
    userId,
    deletedAt: null,
    status: { in: [...FILE_VISIBLE_STATUSES] },
    shareToken: { not: null },
  };
}
