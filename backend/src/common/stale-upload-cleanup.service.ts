import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { CacheService } from '../cache/cache.service';
import { FileLifecycleService } from '../file/file-lifecycle.service';

@Injectable()
export class StaleUploadCleanupService {
  private readonly logger = new Logger(StaleUploadCleanupService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cacheService: CacheService,
    private readonly lifecycleService: FileLifecycleService,
  ) {}

  @Cron(CronExpression.EVERY_6_HOURS)
  async handleCleanup() {
    const lockKey = 'cron:stale-upload';
    const acquired = await this.cacheService.acquireLock(lockKey, 1800);

    if (!acquired) {
      this.logger.debug(
        `Cron ${lockKey} running on another instance, skipping`,
      );
      return;
    }

    try {
      this.logger.log('Starting stale upload cleanup...');

      const staleFiles = await this.prisma.fileRecord.findMany({
        where: {
          status: { in: ['uploading', 'buffered', 'buffer_failed'] },
          updatedAt: { lt: new Date(Date.now() - 24 * 60 * 60 * 1000) }, // > 24h
        },
        take: 100,
      });

      if (staleFiles.length === 0) {
        return;
      }

      for (const file of staleFiles) {
        // Rollback reserved quota
        await this.prisma.user.update({
          where: { id: file.userId },
          data: { usedSpace: { decrement: file.size } },
        });

        // Mark as failed
        await this.prisma.fileRecord.update({
          where: { id: file.id },
          data: { status: 'upload_timeout' },
        });

        // Publish event to clean up chunks on Telegram
        await this.lifecycleService.publishDeleteEvent(file);

        await this.cacheService.invalidateFile(file.id);
        this.logger.log(`Cleaned up stale upload for file ${file.id}`);
      }
    } finally {
      await this.cacheService.releaseLock(lockKey);
    }
  }
}
