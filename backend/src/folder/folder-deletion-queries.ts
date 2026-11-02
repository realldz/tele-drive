import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

/** Active descendants only: previously trashed subtrees keep their restore timestamp. */
export async function softDeleteFolderTree(
  prisma: PrismaService,
  id: string,
  userId: string,
  deletedAt: Date,
) {
  const [counts] = await prisma.$queryRaw<
    Array<{ folders: number; files: number; deletedFolderIds: string[] }>
  >(Prisma.sql`
    WITH RECURSIVE tree AS (
      SELECT "id" FROM "Folder"
      WHERE "id" = ${id} AND "userId" = ${userId} AND "deletedAt" IS NULL
      UNION
      SELECT child."id" FROM "Folder" child JOIN tree ON child."parentId" = tree."id"
      WHERE child."userId" = ${userId} AND child."deletedAt" IS NULL
    ), deleted_files AS (
      UPDATE "FileRecord" SET "deletedAt" = ${deletedAt}, "updatedAt" = ${deletedAt}
      WHERE "folderId" IN (SELECT "id" FROM tree)
        AND "userId" = ${userId} AND "deletedAt" IS NULL
      RETURNING "id"
    ), deleted_folders AS (
      UPDATE "Folder" SET "deletedAt" = ${deletedAt}, "updatedAt" = ${deletedAt}
      WHERE "id" IN (SELECT "id" FROM tree) AND "deletedAt" IS NULL
      RETURNING "id"
    )
    SELECT (SELECT count(*)::int FROM deleted_folders) AS folders,
           (SELECT count(*)::int FROM deleted_files) AS files,
           COALESCE((SELECT array_agg("id") FROM deleted_folders), ARRAY[]::text[]) AS "deletedFolderIds"
  `);
  return counts;
}

/** Includes already trashed descendants when permanently deleting a tree. */
export async function collectFolderFileIds(
  prisma: PrismaService,
  id: string,
  userId: string,
): Promise<string[]> {
  const files = await prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    WITH RECURSIVE tree AS (
      SELECT "id" FROM "Folder" WHERE "id" = ${id} AND "userId" = ${userId}
      UNION
      SELECT child."id" FROM "Folder" child JOIN tree ON child."parentId" = tree."id"
      WHERE child."userId" = ${userId}
    )
    SELECT "id" FROM "FileRecord"
    WHERE "folderId" IN (SELECT "id" FROM tree) AND "userId" = ${userId}
  `);
  return files.map((file) => file.id);
}
