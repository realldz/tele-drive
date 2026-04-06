import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable } from 'rxjs';
import { PrismaService } from '../prisma/prisma.service';
import { CryptoService } from '../crypto/crypto.service';
import { getClientIp } from './utils/get-client-ip';

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

  constructor(
    private readonly prisma: PrismaService,
    private readonly cryptoService: CryptoService,
    private readonly reflector: Reflector,
  ) { }

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<any>> {
    const isCheckOnly = this.reflector.get<boolean>('BANDWIDTH_CHECK_ONLY', context.getHandler()) || false;
    const req = context.switchToHttp().getRequest();
    const res = context.switchToHttp().getResponse();
    let fileId: string | undefined = req.params?.id ?? req.params?.fileId;
    let userId = req.user?.userId;

    // Try to extract userId from stream_token cookie (for /stream/:id routes)
    if (!userId && req.cookies?.stream_token) {
      const streamPayload = this.cryptoService.verifyStreamCookieToken(req.cookies.stream_token);
      if (streamPayload && streamPayload.sub && !streamPayload.sub.startsWith('guest:')) {
        userId = streamPayload.sub;
      }
    }

    // Signed token route (/files/d/:token) — decode token để lấy fileId và userId
    if (!fileId && req.params?.token) {
      const payload = this.cryptoService.verifySignedToken(req.params.token);
      if (payload) {
        fileId = payload.fid;
        if (payload.uid) userId = payload.uid;
      }
    }

    // Share stream route (/files/share/stream/:shareToken, /files/share/:token/stream)
    // Share tokens là plain DB string, không phải HMAC-signed — resolve file trực tiếp từ share token
    if (!fileId) {
      const shareToken = req.params?.shareToken ?? req.params?.token;
      if (shareToken) {
        const file = await this.prisma.fileRecord.findUnique({
          where: { shareToken },
          select: { id: true },
        });
        if (file) {
          fileId = file.id;
        }
      }
    }

    const isAuthenticated = !!userId;

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
        await this.checkPerFileQuota(res, fileId, file, isCheckOnly);
      }
    }

    // User/Guest bandwidth check + optimistic increment
    if (isAuthenticated && userId) {
      await this.checkAndIncrementUserBandwidth(res, userId, fileSize, isCheckOnly);
    } else {
      await this.checkAndIncrementGuestBandwidth(res, req, fileSize, isCheckOnly);
    }
    return next.handle();
  }

  /** Tính thời điểm reset (lastReset + 24h) */
  private getResetAt(lastReset: Date): string {
    return new Date(lastReset.getTime() + 24 * 60 * 60 * 1000).toISOString();
  }

  /** Throw 429 — set resetAt vào header để frontend luôn đọc được (kể cả HEAD request) */
  private throwBandwidthExceeded(res: { setHeader: (name: string, value: string) => void }, code: string, resetAt: string): never {
    res.setHeader('X-Bandwidth-Reset', resetAt);
    throw new HttpException({ code, resetAt }, HttpStatus.TOO_MANY_REQUESTS);
  }

  /**
   * Per-file download quota check.
   * Lazy reset nếu > 24h, check downloadLimit24h, increment downloads24h.
   */
  private async checkPerFileQuota(
    res: { setHeader: (name: string, value: string) => void },
    fileId: string,
    file: { downloadLimit24h: number | null; downloads24h: number; bandwidthLimit24h: bigint | null; bandwidthUsed24h: bigint; lastDownloadReset: Date; size: bigint },
    isCheckOnly: boolean,
  ): Promise<void> {
    const now = new Date();
    const hoursSinceReset = (now.getTime() - file.lastDownloadReset.getTime()) / (1000 * 60 * 60);

    // Lazy reset per-file counters
    if (hoursSinceReset >= 24) {
      if (!isCheckOnly) {
        await this.prisma.fileRecord.update({
          where: { id: fileId },
          data: { downloads24h: 0, bandwidthUsed24h: 0, lastDownloadReset: now },
        });
      }
      return;
    }

    const resetAt = this.getResetAt(file.lastDownloadReset);

    // Check download count limit
    if (file.downloadLimit24h !== null && file.downloads24h >= file.downloadLimit24h) {
      this.logger.warn(`Per-file download limit reached for file ${fileId}: ${file.downloads24h}/${file.downloadLimit24h}`);
      this.throwBandwidthExceeded(res, 'FILE_DOWNLOAD_LIMIT', resetAt);
    }

    // Check per-file bandwidth limit
    if (file.bandwidthLimit24h !== null && file.bandwidthUsed24h + file.size > file.bandwidthLimit24h) {
      this.logger.warn(`Per-file bandwidth limit reached for file ${fileId}`);
      this.throwBandwidthExceeded(res, 'FILE_BANDWIDTH_LIMIT', resetAt);
    }

    // Optimistic increment per-file counters
    if (!isCheckOnly) {
      await this.prisma.fileRecord.update({
        where: { id: fileId },
        data: {
          downloads24h: { increment: 1 },
          bandwidthUsed24h: { increment: file.size },
        },
      });
    }
  }

  private async checkAndIncrementUserBandwidth(res: { setHeader: (name: string, value: string) => void }, userId: string, fileSize: bigint, isCheckOnly: boolean): Promise<void> {
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
      this.throwBandwidthExceeded(res, 'USER_BANDWIDTH_LIMIT', this.getResetAt(user.lastBandwidthReset));
    }

    // Optimistic increment
    if (!isCheckOnly) {
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
  }

  private async checkAndIncrementGuestBandwidth(res: { setHeader: (name: string, value: string) => void }, req: unknown, fileSize: bigint, isCheckOnly: boolean): Promise<void> {
    const ip = getClientIp(req);

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
        this.throwBandwidthExceeded(res, 'GUEST_BANDWIDTH_LIMIT', this.getResetAt(tracker.lastBandwidthReset));
      }

      // Optimistic increment
      if (!isCheckOnly) {
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
      }
    } else {
      // Guest chưa có tracker
      if (limit !== null && fileSize > limit) {
        this.throwBandwidthExceeded(res, 'GUEST_BANDWIDTH_LIMIT', new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString());
      }
      if (!isCheckOnly && fileSize > 0n) {
        await this.prisma.guestTracker.create({
          data: { ipAddress: ip, dailyBandwidthUsed: fileSize },
        });
      }
    }
  }
}
