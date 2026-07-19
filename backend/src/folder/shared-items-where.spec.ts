import {
  buildSharedFolderWhere,
  buildSharedFileWhere,
} from './shared-items-where';

/**
 * Pure unit tests for the "currently shared" where-builders. No DB — asserts the
 * Prisma where-fragment shape so the locked scope contract stays correct:
 *   - folder shared = shareToken set OR s3PublicAccess on
 *   - file shared   = shareToken set
 * Both userId-scoped + deletedAt:null; files status-gated like getContent.
 */
describe('shared-items where builders', () => {
  const userId = 'user-123';

  describe('buildSharedFolderWhere', () => {
    const w = buildSharedFolderWhere(userId);

    it('scopes to the user and excludes soft-deleted rows', () => {
      expect(w.userId).toBe(userId);
      expect(w.deletedAt).toBeNull();
    });

    it('matches shareToken set OR s3PublicAccess on (the OR is the whole point)', () => {
      expect(w.OR).toEqual([
        { shareToken: { not: null } },
        { s3PublicAccess: true },
      ]);
    });
  });

  describe('buildSharedFileWhere', () => {
    const w = buildSharedFileWhere(userId);

    it('scopes to the user and excludes soft-deleted rows', () => {
      expect(w.userId).toBe(userId);
      expect(w.deletedAt).toBeNull();
    });

    it('requires a shareToken (files have no S3-public concept)', () => {
      expect(w.shareToken).toEqual({ not: null });
      expect(w.OR).toBeUndefined();
    });

    it('gates on visible statuses like getContent', () => {
      expect(w.status).toEqual({
        in: ['complete', 'uploading', 'buffered', 'buffer_failed'],
      });
    });
  });
});
