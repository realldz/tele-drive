import { Injectable, Logger, ConflictException } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { FileLifecycleService } from '../file/file-lifecycle.service';
import { CacheService } from '../cache/cache.service';

interface CleanupResult {
  deletedCount: number;
  expiresAt: number;
}

function getErrorMessage(err: unknown): string {
  return err instanceof Error ? (err.stack ?? err.message) : String(err);
}

function isPrismaRecordNotFoundError(err: unknown): boolean {
  return (
    (err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === 'P2025') ||
    (typeof err === 'object' &&
      err !== null &&
      'code' in err &&
      err.code === 'P2025')
  );
}

@Injectable()
export class TrashCleanupService {
  private readonly logger = new Logger(TrashCleanupService.name);
  private readonly cleanupResults = new Map<string, CleanupResult>();
  private readonly CACHE_TTL_MS = 30_000; // 30 seconds

  constructor(
    private readonly prisma: PrismaService,
    private readonly fileLifecycleService: FileLifecycleService,
    private readonly cacheService: CacheService,
  ) {}

  private async clearCleanupFlag(userId: string): Promise<void> {
    await this.prisma.user.update({
      where: { id: userId },
      data: { isCleaningTrash: false },
    });
  }

  private async clearCleanupFlags(userIds: Iterable<string>): Promise<void> {
    for (const userId of userIds) {
      try {
        await this.clearCleanupFlag(userId);
      } catch (err) {
        this.logger.error(
          `Failed to clear trash cleanup flag for user ${userId}: ${getErrorMessage(err)}`,
        );
      }
    }
  }

  /**
   * Check if a user's trash cleanup is currently running.
   */
  async isCleanupRunning(userId: string): Promise<boolean> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { isCleaningTrash: true },
    });
    return user?.isCleaningTrash ?? false;
  }

  /**
   * Get cleanup status for a user including pending trash counts.
   */
  async getCleanupStatus(userId: string): Promise<{
    isCleaning: boolean;
    totalCount: number;
    deletedCount: number;
  }> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { isCleaningTrash: true },
    });

    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - 7);

    const [fileCount, folderCount] = await Promise.all([
      this.prisma.fileRecord.count({
        where: { userId, deletedAt: { not: null } },
      }),
      this.prisma.folder.count({
        where: { userId, deletedAt: { not: null } },
      }),
    ]);

    const cached = this.cleanupResults.get(userId);
    const deletedCount =
      cached && cached.expiresAt > Date.now() ? cached.deletedCount : 0;

    return {
      isCleaning: user?.isCleaningTrash ?? false,
      totalCount: fileCount + folderCount,
      deletedCount,
    };
  }

  /**
   * Start background trash cleanup for a user.
   * Sets isCleaningTrash flag, returns 202 immediately,
   * then deletes all trashed items in the background.
   */
  async startCleanup(userId: string): Promise<{ accepted: boolean }> {
    // Clean expired cache entries
    const now = Date.now();
    for (const [key, value] of this.cleanupResults.entries()) {
      if (value.expiresAt < now) this.cleanupResults.delete(key);
    }

    // Check if cleanup is already running
    const isRunning = await this.isCleanupRunning(userId);
    if (isRunning) {
      throw new ConflictException('Trash cleanup is already in progress');
    }

    // Check if there's anything to clean
    const [fileCount, folderCount] = await Promise.all([
      this.prisma.fileRecord.count({
        where: { userId, deletedAt: { not: null } },
      }),
      this.prisma.folder.count({
        where: { userId, deletedAt: { not: null } },
      }),
    ]);

    if (fileCount === 0 && folderCount === 0) {
      return { accepted: false };
    }

    // Set flag
    await this.prisma.user.update({
      where: { id: userId },
      data: { isCleaningTrash: true },
    });

    // Run cleanup in background (fire-and-forget)
    this._runUserCleanup(userId).catch((err) => {
      this.logger.error(
        `Background cleanup failed for user ${userId}: ${getErrorMessage(err)}`,
      );
    });

    return { accepted: true };
  }

  /**
   * Internal: delete all trashed items for a user, then clear flag.
   */
  private async _runUserCleanup(userId: string): Promise<void> {
    let filesDeleted = 0;
    let foldersDeleted = 0;

    try {
      // 1. Delete all trashed files
      const trashFiles = await this.prisma.fileRecord.findMany({
        where: { userId, deletedAt: { not: null } },
        include: { chunks: true },
      });

      for (const file of trashFiles) {
        try {
          await this.fileLifecycleService.publishDeleteEvent(file);
          await this.fileLifecycleService.purgeTempFiles([file]);
          await this.prisma.$transaction(async (tx) => {
            await tx.fileRecord.delete({ where: { id: file.id } });
            if (file.status === 'complete') {
              await tx.user.update({
                where: { id: file.userId },
                data: { usedSpace: { decrement: file.size } },
              });
            }
          });
          filesDeleted++;
        } catch (err) {
          this.logger.error(
            `Failed to permanently delete file ${file.id}: ${getErrorMessage(err)}`,
          );
        }
      }

      // 2. Delete all trashed folders
      const trashFolders = await this.prisma.folder.findMany({
        where: { userId, deletedAt: { not: null } },
        select: { id: true },
      });

      for (const folder of trashFolders) {
        try {
          await this.prisma.folder.delete({ where: { id: folder.id } });
          foldersDeleted++;
        } catch (err) {
          this.logger.error(
            `Failed to permanently delete folder ${folder.id}: ${getErrorMessage(err)}`,
          );
        }
      }

      this.logger.log(
        `User trash cleanup completed for ${userId}: ${filesDeleted} files, ${foldersDeleted} folders`,
      );
    } finally {
      const totalDeleted = filesDeleted + foldersDeleted;
      this.cleanupResults.set(userId, {
        deletedCount: totalDeleted,
        expiresAt: Date.now() + this.CACHE_TTL_MS,
      });

      // Always clear the flag
      await this.clearCleanupFlags([userId]);
    }
  }

  /**
   * Cron job: clean expired trash items (older than 7 days) across all users.
   * Sets per-user isCleaningTrash flag during cleanup.
   */
  @Cron('0 2 * * *')
  async handleTrashCleanup() {
    const lockKey = 'cron:trash-cleanup';
    const acquired = await this.cacheService.acquireLock(lockKey, 3600);
    if (!acquired) {
      this.logger.debug(
        `Cron ${lockKey} running on another instance, skipping`,
      );
      return;
    }

    this.logger.log('Starting trash cleanup cron job...');

    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - 30);

    const affectedUserIds = new Set<string>();
    let eventsPublished = 0;
    let filesHardDeleted = 0;
    let foldersDeleted = 0;

    try {
      // Phase 1: Publish DELETE_FILE events for expired files not yet deleted from Telegram
      const expiredFiles = await this.prisma.fileRecord.findMany({
        where: {
          deletedAt: { not: null, lt: cutoffDate },
          telegram_deleted: false,
        },
        include: { chunks: true },
        take: 100,
      });

      for (const file of expiredFiles) {
        try {
          await this.fileLifecycleService.publishDeleteEvent(file);
          eventsPublished++;
          affectedUserIds.add(file.userId);
        } catch (err) {
          this.logger.error(
            `Failed to publish delete event for file ${file.id}: ${getErrorMessage(err)}`,
          );
        }
      }

      // Phase 2: Hard delete files that Go has confirmed deleted from Telegram
      const confirmedDeleted = await this.prisma.fileRecord.findMany({
        where: {
          deletedAt: { not: null, lt: cutoffDate },
          telegram_deleted: true,
        },
        take: 500,
      });

      if (confirmedDeleted.length > 0) {
        const userIds = new Set(confirmedDeleted.map((f) => f.userId));
        for (const uid of userIds) {
          await this.prisma.user.update({
            where: { id: uid },
            data: { isCleaningTrash: true },
          });
          affectedUserIds.add(uid);
        }

        const ids = confirmedDeleted.map((f) => f.id);
        let freedSize = 0n;
        for (const file of confirmedDeleted) {
          if (file.status === 'complete') {
            freedSize += file.size;
          }
        }

        await this.prisma.$transaction(async (tx) => {
          await tx.fileChunk.deleteMany({ where: { fileId: { in: ids } } });
          await tx.fileRecord.deleteMany({ where: { id: { in: ids } } });

          if (freedSize > 0n) {
            for (const uid of userIds) {
              const userFiles = confirmedDeleted.filter(
                (f) => f.userId === uid,
              );
              const userFreed = userFiles.reduce((sum, f) => {
                return f.status === 'complete' ? sum + f.size : sum;
              }, 0n);
              if (userFreed > 0n) {
                await tx.user.update({
                  where: { id: uid },
                  data: { usedSpace: { decrement: userFreed } },
                });
              }
            }
          }
        });

        filesHardDeleted = confirmedDeleted.length;
        this.logger.log(
          `Hard deleted ${filesHardDeleted} files confirmed by Go`,
        );
      }

      // 3. Delete expired folders (same as before)
      const expiredFolders = await this.prisma.folder.findMany({
        where: { deletedAt: { not: null, lt: cutoffDate } },
        select: { id: true, userId: true },
      });

      for (const uid of new Set(expiredFolders.map((f) => f.userId))) {
        affectedUserIds.add(uid);
      }

      for (const folder of expiredFolders) {
        try {
          const exists = await this.prisma.folder.findUnique({
            where: { id: folder.id },
          });
          if (!exists) continue;

          await this.prisma.folder.delete({
            where: { id: folder.id },
          });
          foldersDeleted++;
        } catch (err) {
          if (isPrismaRecordNotFoundError(err)) {
            this.logger.warn(
              `Skipped deleting folder ${folder.id} (already removed)`,
            );
            continue;
          }
          this.logger.error(
            `Failed to delete folder ${folder.id}: ${getErrorMessage(err)}`,
          );
        }
      }

      this.logger.log(
        `Trash cleanup cron completed: ${eventsPublished} events published, ${filesHardDeleted} files hard deleted, ${foldersDeleted} folders deleted`,
      );
    } catch (err) {
      this.logger.error(`Trash cleanup cron failed: ${getErrorMessage(err)}`);
    } finally {
      await this.clearCleanupFlags(affectedUserIds);
    }
  }
}
