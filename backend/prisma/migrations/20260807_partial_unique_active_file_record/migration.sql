-- Partial unique index preventing duplicate *active* S3 objects.
--
-- WHY (hazard): two concurrent S3 PUTs to the same key can both create an
-- active FileRecord (same userId + folderId + filename, deletedAt IS NULL).
-- This index makes the DB the arbiter of that race: only one request wins the
-- row; every loser hits a unique violation (Prisma P2002), which the
-- controller maps to a 409 Conflict (see assertNoKeyConflict in
-- grpc-core.controller.ts).
--
-- Soft-deleted rows must be allowed to coexist with the active row (the
-- overwrite-to-trash flow soft-deletes the old version and creates a new
-- active one), so the uniqueness is deliberately scoped to active rows only —
-- a plain full unique index on (userId, folderId, filename) would BREAK that.
--
-- HOW APPLIED (this repo uses `prisma db push`, there are NO prisma
-- migrations): apply manually against the database:
--
--     docker compose exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
--       -f /path/to/backend/prisma/migrations/20260807_partial_unique_active_file_record/migration.sql
--
-- The repo does NOT track a migrations history, so `prisma db push` will not
-- see or drop this index — it must be applied once per environment and will
-- persist until explicitly dropped.
--
-- Prisma 6.19 cannot express a partial index in schema.prisma (no `where` on
-- @@index / @@unique until Prisma 8). If the project upgrades to Prisma 8,
-- mirror this in schema.prisma as:
--     @@index([userId, folderId, filename], where: "deletedAt IS NULL", unique: true)
-- and drop the manual index (prisma migrate diff) to keep one source of truth.

CREATE UNIQUE INDEX "file_record_active_unique_key"
  ON "FileRecord" ("userId", "folderId", "filename")
  WHERE "deletedAt" IS NULL;
