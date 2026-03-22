import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { PrismaService } from '../prisma/prisma.service';

/**
 * BandwidthInterceptor — gắn vào route download/stream.
 *
 * Flow:
 *  1. Lấy file size từ DB (dựa vào :id param)
 *  2. Lazy Reset: nếu lastBandwidthReset > 24h → reset dailyBandwidthUsed = 0
 *  3. Pre-check: dailyBandwidthUsed + fileSize > dailyBandwidthLimit → HTTP 429
 *  4. Pre-check per-file quota: downloads24h >= downloadLimit24h → HTTP 429
 *  5. Optimistic increment: cộng bandwidth + download count TRƯỚC khi download
 *
 * Lý do dùng optimistic increment: download handler dùng @Res() nên
 * RxJS tap operator không fire được. Increment trước đảm bảo tracking chính xác.
 *
 * Hỗ trợ cả User (qua JWT) và Guest (qua IP → GuestTracker).
 */
@Injectable()
export class BandwidthInterceptor implements NestInterceptor {
  private readonly logger = new Logger(BandwidthInterceptor.name);

  constructor(private readonly prisma: PrismaService) {}

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<any>> {
    const req = context.switchToHttp().getRequest();
    const fileId = req.params?.id;
    const isAuthenticated = !!req.user?.userId;

    // Lấy file size từ DB
    let fileSize = 0n;
    if (fileId) {
      const file = await this.prisma.fileRecord.findUnique({
        where: { id: fileId },
        select: { size: true, downloadLimit24h: true, downloads24h: true, bandwidthLimit24h: true, bandwidthUsed24h: true, lastDownloadReset: true },
      });
      if (file) {
        fileSize = file.size;

        // Per-file quota check + lazy reset
        await this.checkPerFileQuota(fileId, file);
      }
    }

    // User/Guest bandwidth check + optimistic increment
    if (isAuthenticated) {
      await this.checkAndIncrementUserBandwidth(req.user.userId, fileSize);
    } else {
      await this.checkAndIncrementGuestBandwidth(req, fileSize);
    }

    return next.handle();
  }

  /**
   * Per-file download quota check.
   * Lazy reset nếu > 24h, check downloadLimit24h, increment downloads24h.
   */
  private async checkPerFileQuota(
    fileId: string,
    file: { downloadLimit24h: number | null; downloads24h: number; bandwidthLimit24h: bigint | null; bandwidthUsed24h: bigint; lastDownloadReset: Date; size: bigint },
  ): Promise<void> {
    const now = new Date();
    const hoursSinceReset = (now.getTime() - file.lastDownloadReset.getTime()) / (1000 * 60 * 60);

    // Lazy reset per-file counters
    if (hoursSinceReset >= 24) {
      await this.prisma.fileRecord.update({
        where: { id: fileId },
        data: { downloads24h: 0, bandwidthUsed24h: 0, lastDownloadReset: now },
      });
      // After reset, allow download
      return;
    }

    // Check download count limit
    if (file.downloadLimit24h !== null && file.downloads24h >= file.downloadLimit24h) {
      this.logger.warn(`Per-file download limit reached for file ${fileId}: ${file.downloads24h}/${file.downloadLimit24h}`);
      throw new HttpException(
        'This file has reached its daily download limit.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    // Check per-file bandwidth limit
    if (file.bandwidthLimit24h !== null && file.bandwidthUsed24h + file.size > file.bandwidthLimit24h) {
      this.logger.warn(`Per-file bandwidth limit reached for file ${fileId}`);
      throw new HttpException(
        'This file has reached its daily bandwidth limit.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    // Optimistic increment per-file counters
    await this.prisma.fileRecord.update({
      where: { id: fileId },
      data: {
        downloads24h: { increment: 1 },
        bandwidthUsed24h: { increment: file.size },
      },
    });
  }

  private async checkAndIncrementUserBandwidth(userId: string, fileSize: bigint): Promise<void> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        dailyBandwidthUsed: true,
        dailyBandwidthLimit: true,
        lastBandwidthReset: true,
      },
    });
    if (!user) return;

    const now = new Date();
    const hoursSinceReset = (now.getTime() - user.lastBandwidthReset.getTime()) / (1000 * 60 * 60);
    const requiresReset = hoursSinceReset >= 24;

    // Lấy bandwidth limit: user-specific hoặc system default
    let limit = user.dailyBandwidthLimit;
    if (limit === null) {
      const setting = await this.prisma.systemSetting.findUnique({
        where: { key: 'DEFAULT_USER_BANDWIDTH' },
      });
      limit = setting ? BigInt(setting.value) : null;
    }

    const currentUsed = requiresReset ? 0n : user.dailyBandwidthUsed;

    // Pre-check (nếu có limit)
    if (limit !== null && currentUsed + fileSize > limit) {
      this.logger.warn(`Bandwidth limit exceeded for user ${userId}: used=${currentUsed}, limit=${limit}`);
      throw new HttpException(
        'Daily bandwidth limit exceeded. Please try again tomorrow.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    // Optimistic increment
    if (requiresReset) {
      await this.prisma.user.update({
        where: { id: userId },
        data: {
          dailyBandwidthUsed: fileSize,
          lastBandwidthReset: now,
        },
      });
      this.logger.debug(`Bandwidth reset for user ${userId}`);
    } else if (fileSize > 0n) {
      await this.prisma.user.update({
        where: { id: userId },
        data: { dailyBandwidthUsed: { increment: fileSize } },
      });
    }
  }

  private async checkAndIncrementGuestBandwidth(req: any, fileSize: bigint): Promise<void> {
    const ip = this.getClientIp(req);

    // Lấy guest bandwidth limit từ system settings
    const setting = await this.prisma.systemSetting.findUnique({
      where: { key: 'DEFAULT_GUEST_BANDWIDTH' },
    });
    const limit = setting ? BigInt(setting.value) : null;

    let tracker = await this.prisma.guestTracker.findUnique({
      where: { ipAddress: ip },
    });

    const now = new Date();

    if (tracker) {
      const hoursSinceReset = (now.getTime() - tracker.lastBandwidthReset.getTime()) / (1000 * 60 * 60);
      const requiresReset = hoursSinceReset >= 24;
      const currentUsed = requiresReset ? 0n : tracker.dailyBandwidthUsed;

      if (limit !== null && currentUsed + fileSize > limit) {
        this.logger.warn(`Bandwidth limit exceeded for guest ${ip}: used=${currentUsed}, limit=${limit}`);
        throw new HttpException(
          'Daily bandwidth limit exceeded. Please try again tomorrow.',
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }

      // Optimistic increment
      if (requiresReset) {
        await this.prisma.guestTracker.update({
          where: { ipAddress: ip },
          data: {
            dailyBandwidthUsed: fileSize,
            lastBandwidthReset: now,
          },
        });
        this.logger.debug(`Bandwidth reset for guest ${ip}`);
      } else if (fileSize > 0n) {
        await this.prisma.guestTracker.update({
          where: { ipAddress: ip },
          data: { dailyBandwidthUsed: { increment: fileSize } },
        });
      }
    } else {
      // Guest chưa có tracker
      if (limit !== null && fileSize > limit) {
        throw new HttpException(
          'Daily bandwidth limit exceeded. Please try again tomorrow.',
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
      if (fileSize > 0n) {
        await this.prisma.guestTracker.create({
          data: { ipAddress: ip, dailyBandwidthUsed: fileSize },
        });
      }
    }
  }

  private getClientIp(req: any): string {
    return req.ip || req.connection?.remoteAddress || '127.0.0.1';
  }
}
