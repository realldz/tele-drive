import { Injectable, Logger, ConflictException } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { FileService } from '../file/file.service';

interface CleanupResult {
  deletedCount: number;
  expiresAt: number;
}

function getErrorMessage(err: unknown): string {
  return err instanceof Error
    ? (err.stack ?? err.message)
    : String(err);
}

@Injectable()
export class TrashCleanupService {
  private readonly logger = new Logger(TrashCleanupService.name);
  private readonly cleanupResults = new Map<string, CleanupResult>();
  private readonly CACHE_TTL_MS = 30_000; // 30 seconds

  constructor(
    private readonly prisma: PrismaService,
    private readonly fileService: FileService,
  ) {}

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
          await this.fileService.purgeFilesFromTelegram([file]);
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
      await this.prisma.user.update({
        where: { id: userId },
        data: { isCleaningTrash: false },
      });
    }
  }

  /**
   * Cron job: clean expired trash items (older than 7 days) across all users.
   * Sets per-user isCleaningTrash flag during cleanup.
   */
  @Cron('0 2 * * *')
  async handleTrashCleanup() {
    this.logger.log('Starting trash cleanup cron job...');

    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - 7);

    // 1. Delete expired files
    const expiredFiles = await this.prisma.fileRecord.findMany({
      where: { deletedAt: { not: null, lt: cutoffDate } },
      include: { chunks: true },
    });

    // Group files by userId to set per-user flags
    const userIds = new Set(expiredFiles.map((f) => f.userId));
    const fileCountsByUser = new Map<string, number>();

    // Set flags for affected users
    for (const uid of userIds) {
      await this.prisma.user.update({
        where: { id: uid },
        data: { isCleaningTrash: true },
      });
      fileCountsByUser.set(uid, 0);
    }

    try {
      let filesDeleted = 0;
      for (const file of expiredFiles) {
        try {
          await this.fileService.purgeFilesFromTelegram([file]);
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
          fileCountsByUser.set(
            file.userId,
            (fileCountsByUser.get(file.userId) ?? 0) + 1,
          );
        } catch (err) {
          this.logger.error(
            `Failed to permanently delete file ${file.id}: ${getErrorMessage(err)}`,
          );
        }
      }

      // 2. Delete expired folders
      const expiredFolders = await this.prisma.folder.findMany({
        where: { deletedAt: { not: null, lt: cutoffDate } },
        select: { id: true, userId: true },
      });

      const folderUserIds = new Set(expiredFolders.map((f) => f.userId));
      const folderCountsByUser = new Map<string, number>();

      for (const uid of folderUserIds) {
        if (!userIds.has(uid)) {
          await this.prisma.user.update({
            where: { id: uid },
            data: { isCleaningTrash: true },
          });
          userIds.add(uid);
        }
        folderCountsByUser.set(uid, 0);
      }

      let foldersDeleted = 0;
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
          folderCountsByUser.set(
            folder.userId,
            (folderCountsByUser.get(folder.userId) ?? 0) + 1,
          );
        } catch (err) {
          this.logger.error(
            `Failed to permanently delete folder ${folder.id}: ${getErrorMessage(err)}`,
          );
        }
      }

      // Cache results per user
      const now = Date.now();
      for (const uid of userIds) {
        const totalDeleted =
          (fileCountsByUser.get(uid) ?? 0) + (folderCountsByUser.get(uid) ?? 0);
        this.cleanupResults.set(uid, {
          deletedCount: totalDeleted,
          expiresAt: now + this.CACHE_TTL_MS,
        });
      }

      this.logger.log(
        `Trash cleanup cron completed: ${filesDeleted} files, ${foldersDeleted} folders permanently deleted`,
      );
    } finally {
      // Clear flags for all affected users
      for (const uid of userIds) {
        await this.prisma.user.update({
          where: { id: uid },
          data: { isCleaningTrash: false },
        });
      }
    }
  }
}
