import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { CacheService } from '../cache/cache.service';

@Injectable()
export class QuotaSyncService {
  private readonly logger = new Logger(QuotaSyncService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cacheService: CacheService,
  ) {}

  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async syncQuotas() {
    const lockKey = 'cron:quota-sync';
    const acquired = await this.cacheService.acquireLock(lockKey, 7200);

    if (!acquired) return;

    try {
      this.logger.log('Starting quota synchronization...');

      const results = await this.prisma.$queryRaw<
        { userId: string; actual_used: bigint }[]
      >`
        SELECT "userId", COALESCE(SUM(size), 0) as actual_used
        FROM "FileRecord"
        WHERE "deletedAt" IS NULL AND status = 'complete'
        GROUP BY "userId"
      `;

      this.logger.log(
        `Found ${results.length} users with data. Batch updating...`,
      );

      for (let i = 0; i < results.length; i += 100) {
        const batch = results.slice(i, i + 100);

        await this.prisma.$transaction(async (tx) => {
          for (const row of batch) {
            await tx.user.update({
              where: { id: row.userId },
              data: { usedSpace: row.actual_used },
            });
            await this.cacheService.invalidateUserQuota(row.userId);
          }
        });

        await new Promise((resolve) => setTimeout(resolve, 100));
      }

      this.logger.log('Quota synchronization complete');
    } catch (err) {
      this.logger.error('Failed to sync quotas', err);
    } finally {
      await this.cacheService.releaseLock(lockKey);
    }
  }
}
