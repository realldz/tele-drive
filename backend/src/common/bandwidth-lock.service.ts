import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

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

  constructor(private readonly prisma: PrismaService) {}

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
  ): Promise<void> {
    await this.prisma.fileRecord.update({
      where: { id: fileId },
      data: {
        bandwidthUsed24h: { increment: actualBytes },
        ...(actualBytes >= estimatedSize
          ? { downloads24h: { increment: 1 } }
          : {}),
      },
    });
  }

  private throwLimitExceeded(code: string, lastReset: Date): never {
    const resetAt = new Date(lastReset.getTime() + 86_400_000).toISOString();
    throw new Error(`${code}:${resetAt}`);
  }
}
