import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CacheService } from '../cache/cache.service';

interface LockResult {
  requiresReset: boolean;
}

interface RefundData {
  userId: string | null;
  estimatedSize: bigint;
  ip: string;
}

@Injectable()
export class BandwidthLockService {
  private readonly logger = new Logger(BandwidthLockService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cacheService: CacheService,
  ) {}

  /** Pre-check + LOCK bandwidth. Trả về `requiresReset` để reconcile dùng. */
  async lockBandwidth(
    userId: string | undefined,
    lockSize: bigint,
    ip: string,
  ): Promise<LockResult> {
    const now = new Date();
    return userId
      ? this.lockUserBandwidth(userId, lockSize, now)
      : this.lockGuestBandwidth(ip, lockSize, now);
  }

  private async lockUserBandwidth(
    userId: string,
    lockSize: bigint,
    now: Date,
  ): Promise<LockResult> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        dailyBandwidthUsed: true,
        dailyBandwidthLimit: true,
        lastBandwidthReset: true,
      },
    });
    if (!user) return { requiresReset: false };

    const { requiresReset, currentUsed, limit } = await this.resolveUserUsage(
      user,
      now,
    );

    if (limit !== null && currentUsed + lockSize > limit) {
      this.throwLimitExceeded('USER_BANDWIDTH_LIMIT', user.lastBandwidthReset);
    }

    if (requiresReset) {
      await this.prisma.user.update({
        where: { id: userId },
        data: { dailyBandwidthUsed: lockSize, lastBandwidthReset: now },
      });
    } else if (lockSize > 0n) {
      await this.prisma.user.update({
        where: { id: userId },
        data: { dailyBandwidthUsed: { increment: lockSize } },
      });
    }

    // Sync to Redis for Go transfer service to check bandwidth
    this.cacheService
      .syncUserBandwidth(userId, {
        dailyBandwidthUsed: requiresReset ? lockSize : currentUsed + lockSize,
        dailyBandwidthLimit: limit,
        lastBandwidthReset: requiresReset ? now : user.lastBandwidthReset,
      })
      .catch(() => {});

    return { requiresReset };
  }

  private async lockGuestBandwidth(
    ip: string,
    lockSize: bigint,
    now: Date,
  ): Promise<LockResult> {
    const setting = await this.prisma.systemSetting.findUnique({
      where: { key: 'DEFAULT_GUEST_BANDWIDTH' },
    });
    const limit = setting ? BigInt(setting.value) : null;
    const tracker = await this.prisma.guestTracker.findUnique({
      where: { ipAddress: ip },
    });

    if (tracker) {
      const { requiresReset, currentUsed } = this.resolveGuestUsage(
        tracker.lastBandwidthReset,
        tracker.dailyBandwidthUsed,
        now,
      );
      if (limit !== null && currentUsed + lockSize > limit) {
        this.throwLimitExceeded(
          'GUEST_BANDWIDTH_LIMIT',
          tracker.lastBandwidthReset,
        );
      }
      const data = requiresReset
        ? { dailyBandwidthUsed: lockSize, lastBandwidthReset: now }
        : { dailyBandwidthUsed: { increment: lockSize } };
      await this.prisma.guestTracker.update({ where: { ipAddress: ip }, data });
      return { requiresReset };
    }

    if (limit !== null && lockSize > limit) {
      this.throwLimitExceeded('GUEST_BANDWIDTH_LIMIT', now);
    }
    if (lockSize > 0n) {
      await this.prisma.guestTracker.create({
        data: { ipAddress: ip, dailyBandwidthUsed: lockSize },
      });
    }
    return { requiresReset: false };
  }

  private async resolveUserUsage(
    user: {
      dailyBandwidthUsed: bigint;
      dailyBandwidthLimit: bigint | null;
      lastBandwidthReset: Date;
    },
    now: Date,
  ): Promise<{
    requiresReset: boolean;
    currentUsed: bigint;
    limit: bigint | null;
  }> {
    const hoursSince =
      (now.getTime() - user.lastBandwidthReset.getTime()) / 3_600_000;
    const requiresReset = hoursSince >= 24;
    let limit = user.dailyBandwidthLimit;
    if (limit === null) {
      const setting = await this.prisma.systemSetting.findUnique({
        where: { key: 'DEFAULT_USER_BANDWIDTH' },
      });
      limit = setting ? BigInt(setting.value) : null;
    }
    return {
      requiresReset,
      currentUsed: requiresReset ? 0n : user.dailyBandwidthUsed,
      limit,
    };
  }

  private resolveGuestUsage(lastReset: Date, currentUsed: bigint, now: Date) {
    const hoursSince = (now.getTime() - lastReset.getTime()) / 3_600_000;
    return {
      requiresReset: hoursSince >= 24,
      currentUsed: hoursSince >= 24 ? 0n : currentUsed,
    };
  }

  /**
   * Read-only quota snapshot for the Go data plane (cache-aside seed).
   * Resolves all three tiers — user/guest daily + per-file — applying the 24h
   * reset VIRTUALLY (does NOT write DB; the Go side owns the Redis lock and the
   * cron/lock path owns the real reset write). Returns current usage so Go can
   * seed `user:{id}:quota` / `guest:{ip}:quota` and enforce locally.
   */
  async getQuotaSnapshot(
    userId: string,
    ip: string,
    fileId: string,
  ): Promise<{
    dailyUsed: bigint;
    dailyLimit: bigint | null;
    lastReset: Date;
    isGuest: boolean;
    file: {
      downloads24h: number;
      downloadLimit24h: number | null;
      bandwidthUsed24h: bigint;
      bandwidthLimit24h: bigint | null;
      lastDownloadReset: Date;
    } | null;
  }> {
    const now = new Date();
    let dailyUsed = 0n;
    let dailyLimit: bigint | null = null;
    let lastReset = now;

    if (userId) {
      const user = await this.prisma.user.findUnique({
        where: { id: userId },
        select: {
          dailyBandwidthUsed: true,
          dailyBandwidthLimit: true,
          lastBandwidthReset: true,
        },
      });
      if (user) {
        const { requiresReset, currentUsed, limit } =
          await this.resolveUserUsage(user, now);
        dailyUsed = currentUsed;
        dailyLimit = limit;
        lastReset = requiresReset ? now : user.lastBandwidthReset;
      }
    } else if (ip) {
      const setting = await this.prisma.systemSetting.findUnique({
        where: { key: 'DEFAULT_GUEST_BANDWIDTH' },
      });
      dailyLimit = setting ? BigInt(setting.value) : null;
      const tracker = await this.prisma.guestTracker.findUnique({
        where: { ipAddress: ip },
      });
      if (tracker) {
        const { requiresReset, currentUsed } = this.resolveGuestUsage(
          tracker.lastBandwidthReset,
          tracker.dailyBandwidthUsed,
          now,
        );
        dailyUsed = currentUsed;
        lastReset = requiresReset ? now : tracker.lastBandwidthReset;
      }
    }

    let file: {
      downloads24h: number;
      downloadLimit24h: number | null;
      bandwidthUsed24h: bigint;
      bandwidthLimit24h: bigint | null;
      lastDownloadReset: Date;
    } | null = null;
    if (fileId) {
      const f = await this.prisma.fileRecord.findUnique({
        where: { id: fileId },
        select: {
          downloads24h: true,
          downloadLimit24h: true,
          bandwidthUsed24h: true,
          bandwidthLimit24h: true,
          lastDownloadReset: true,
        },
      });
      if (f) {
        const hoursSince =
          (now.getTime() - f.lastDownloadReset.getTime()) / 3_600_000;
        const requiresReset = hoursSince >= 24;
        file = {
          downloads24h: requiresReset ? 0 : f.downloads24h,
          downloadLimit24h: f.downloadLimit24h,
          bandwidthUsed24h: requiresReset ? 0n : f.bandwidthUsed24h,
          bandwidthLimit24h: f.bandwidthLimit24h,
          lastDownloadReset: requiresReset ? now : f.lastDownloadReset,
        };
      }
    }

    return { dailyUsed, dailyLimit, lastReset, isGuest: !userId, file };
  }

  async refundBandwidth(
    data: RefundData,
    amount: bigint,
    requiresReset: boolean,
  ): Promise<void> {
    if (data.userId) {
      const updateData = requiresReset
        ? { dailyBandwidthUsed: data.estimatedSize - amount }
        : { dailyBandwidthUsed: { decrement: amount } };
      await this.prisma.user.update({
        where: { id: data.userId },
        data: updateData,
      });
      this.logger.debug(
        `Refunded ${amount} bytes bandwidth to user ${data.userId}`,
      );
    } else {
      const updateData = requiresReset
        ? { dailyBandwidthUsed: data.estimatedSize - amount }
        : { dailyBandwidthUsed: { decrement: amount } };
      await this.prisma.guestTracker.update({
        where: { ipAddress: data.ip },
        data: updateData,
      });
      this.logger.debug(
        `Refunded ${amount} bytes bandwidth to guest ${data.ip}`,
      );
    }
  }

  async reconcilePerFileCounters(
    fileId: string,
    actualBytes: bigint,
    estimatedSize: bigint,
    countAsDownload: boolean,
  ): Promise<void> {
    await this.prisma.fileRecord.update({
      where: { id: fileId },
      data: {
        bandwidthUsed24h: { increment: actualBytes },
        ...(countAsDownload && actualBytes >= estimatedSize
          ? { downloads24h: { increment: 1 } }
          : {}),
      },
    });
  }

  async reconcileFromReport(
    entries: Array<{
      userId: string;
      fileId: string;
      actualBytes: bigint;
      countDownload: boolean;
    }>,
  ): Promise<{ accepted: number }> {
    let accepted = 0;
    for (const entry of entries) {
      try {
        if (entry.actualBytes > 0n) {
          await this.prisma.user.updateMany({
            where: { id: entry.userId },
            data: { dailyBandwidthUsed: { increment: entry.actualBytes } },
          });
        }
        await this.prisma.fileRecord.updateMany({
          where: { id: entry.fileId },
          data: {
            bandwidthUsed24h: { increment: entry.actualBytes },
            ...(entry.countDownload ? { downloads24h: { increment: 1 } } : {}),
          },
        });
        accepted++;
        // Do NOT DEL the quota cache here. The Go data plane HIncrBy's the Redis
        // hash at lock time and reads it cache-aside; deleting it after every
        // report would wipe the seeded quota each request, so the limit could
        // never accumulate. The hash self-heals via its TTL + cache-aside reseed.
      } catch {
        this.logger.warn(
          `Failed to reconcile bandwidth for file ${entry.fileId} user ${entry.userId}`,
        );
      }
    }
    return { accepted };
  }

  private throwLimitExceeded(code: string, lastReset: Date): never {
    const resetAt = new Date(lastReset.getTime() + 86_400_000).toISOString();
    throw new Error(`${code}:${resetAt}`);
  }
}
