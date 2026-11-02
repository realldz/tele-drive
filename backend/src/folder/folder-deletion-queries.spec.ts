import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  collectFolderFileIds,
  softDeleteFolderTree,
} from './folder-deletion-queries';

describe('folder deletion SQL (embedded PostgreSQL)', () => {
  let db: PGlite;
  const query = jest.fn();
  const prisma = { $queryRaw: query } as unknown as PrismaService;
  const now = new Date('2026-11-02T10:00:00.123Z');
  const earlier = new Date('2026-11-01T10:00:00.456Z');

  beforeAll(async () => {
    // Prisma reads timestamp-without-time-zone values as UTC, not host local time.
    db = new PGlite({ parsers: { 1114: (value) => new Date(value + 'Z') } });
    await db.exec(`
      CREATE TABLE "Folder" (
        "id" text PRIMARY KEY, "parentId" text, "userId" text,
        "deletedAt" timestamp(3), "updatedAt" timestamp(3)
      );
      CREATE TABLE "FileRecord" (
        "id" text PRIMARY KEY, "folderId" text, "userId" text,
        "deletedAt" timestamp(3), "updatedAt" timestamp(3),
        "size" bigint DEFAULT 100, "isChunked" boolean DEFAULT false
      );
    `);
  }, 30000);

  beforeEach(async () => {
    query
      .mockReset()
      .mockImplementation(
        async (sql: Prisma.Sql) => (await db.query(sql.text, sql.values)).rows,
      );
    await db.exec('TRUNCATE "FileRecord", "Folder";');
    await db.exec(`
      INSERT INTO "Folder" ("id", "parentId", "userId") VALUES
        ('root', null, 'u'), ('child', 'root', 'u'),
        ('old', 'root', 'u'), ('old-child', 'old', 'u'), ('other', null, 'v');
      INSERT INTO "FileRecord" ("id", "folderId", "userId", "isChunked") VALUES
        ('single', 'root', 'u', false), ('chunked', 'child', 'u', true),
        ('old-file', 'root', 'u', false), ('under-old', 'old-child', 'u', false),
        ('foreign', 'other', 'v', false);
    `);
    await db.query('UPDATE "Folder" SET "deletedAt" = $1 WHERE "id" = $2', [
      earlier,
      'old',
    ]);
    await db.query('UPDATE "FileRecord" SET "deletedAt" = $1 WHERE "id" = $2', [
      earlier,
      'old-file',
    ]);
  });

  afterAll(async () => {
    await db.close();
  });

  it('marks only active descendants, preserving prior trash and file sizes', async () => {
    expect(await softDeleteFolderTree(prisma, 'root', 'u', now)).toMatchObject({
      folders: 2,
      files: 2,
    });
    expect(query).toHaveBeenCalledTimes(1);
    const { rows } = await db.query<{
      id: string;
      deletedAt: Date | null;
      size: bigint;
    }>('SELECT "id", "deletedAt", "size" FROM "FileRecord" ORDER BY "id"');
    expect(rows.find((file) => file.id === 'single')?.deletedAt).toEqual(now);
    expect(rows.find((file) => file.id === 'chunked')?.deletedAt).toEqual(now);
    expect(rows.find((file) => file.id === 'old-file')?.deletedAt).toEqual(
      earlier,
    );
    expect(rows.find((file) => file.id === 'under-old')?.deletedAt).toBeNull();
    expect(rows.find((file) => file.id === 'foreign')?.deletedAt).toBeNull();
    expect(rows.every((file) => BigInt(file.size) === 100n)).toBe(true);
    const restored = await db.query(
      'UPDATE "FileRecord" SET "deletedAt" = NULL WHERE "deletedAt" = $1 RETURNING "id"',
      [now],
    );
    expect(restored.rows).toHaveLength(2);
  });

  it('does not touch another owner or allow SQL injection', async () => {
    expect(await softDeleteFolderTree(prisma, 'root', 'v', now)).toMatchObject({
      folders: 0,
      files: 0,
    });
    expect(
      await softDeleteFolderTree(prisma, "root' OR true --", 'u', now),
    ).toMatchObject({ folders: 0, files: 0 });
  });

  it('returns affected folder IDs for reconciling unselected search descendants', async () => {
    const result = await softDeleteFolderTree(prisma, 'root', 'u', now);
    expect(result.deletedFolderIds.sort()).toEqual(['child', 'root']);
  });

  it('does not overwrite deletion timestamps when called twice', async () => {
    await softDeleteFolderTree(prisma, 'root', 'u', now);
    expect(await softDeleteFolderTree(prisma, 'root', 'u', new Date())).toEqual(
      { folders: 0, files: 0, deletedFolderIds: [] },
    );
    const { rows } = await db.query<{ deletedAt: Date }>(
      'SELECT "deletedAt" FROM "Folder" WHERE "id" = $1',
      ['root'],
    );
    expect(rows[0].deletedAt).toEqual(now);
  });

  it('rolls back the whole statement when any update fails', async () => {
    await db.exec(
      `ALTER TABLE "FileRecord" ADD CONSTRAINT reject_delete CHECK ("id" <> 'chunked' OR "deletedAt" IS NULL)`,
    );
    try {
      await expect(
        softDeleteFolderTree(prisma, 'root', 'u', now),
      ).rejects.toThrow();
      const folders = await db.query(
        'SELECT "id" FROM "Folder" WHERE "deletedAt" = $1',
        [now],
      );
      const files = await db.query(
        'SELECT "id" FROM "FileRecord" WHERE "deletedAt" = $1',
        [now],
      );
      expect(folders.rows).toHaveLength(0);
      expect(files.rows).toHaveLength(0);
    } finally {
      await db.exec('ALTER TABLE "FileRecord" DROP CONSTRAINT reject_delete');
    }
  });

  it('collects active and previously trashed files in one query for permanent deletion', async () => {
    expect((await collectFolderFileIds(prisma, 'root', 'u')).sort()).toEqual([
      'chunked',
      'old-file',
      'single',
      'under-old',
    ]);
    expect(query).toHaveBeenCalledTimes(1);
    expect(await collectFolderFileIds(prisma, 'root', 'v')).toEqual([]);
  });

  it('keeps one DB round trip for a large tree', async () => {
    await db.exec(`
      INSERT INTO "Folder" ("id", "parentId", "userId")
        SELECT 'folder-' || n, 'child', 'u' FROM generate_series(1, 1000) n;
      INSERT INTO "FileRecord" ("id", "folderId", "userId")
        SELECT 'file-' || n, 'folder-' || (1 + n % 1000), 'u' FROM generate_series(1, 5000) n;
    `);
    expect(await softDeleteFolderTree(prisma, 'root', 'u', now)).toMatchObject({
      folders: 1002,
      files: 5002,
    });
    expect(query).toHaveBeenCalledTimes(1);
  });
});
