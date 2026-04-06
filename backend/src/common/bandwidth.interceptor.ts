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
import { BandwidthLockService } from './bandwidth-lock.service';
import { getClientIp } from './utils/get-client-ip';

interface BandwidthReconcileData {
  fileId: string;
  userId: string | null;
  estimatedSize: bigint;
  requiresReset: boolean;
  ip: string;
}

type ExpressRequest = {
  params?: Record<string, string>;
  user?: Record<string, unknown>;
  cookies?: Record<string, string>;
  headers: Record<string, string | undefined>;
};

type ExpressResponse = {
  on: (event: string, cb: () => void) => void;
  getHeader: (name: string) => string | number | undefined;
  setHeader: (name: string, value: string) => void;
  socket?: { bytesWritten?: number };
  _bwReconciled?: boolean;
};

/**
 * Parse Range header để tính bytes cần lock.
 * Hỗ trợ: `bytes=start-end`, `bytes=start-`, `bytes=-suffix`.
 * Nếu không có Range hoặc multi-range → trả về full fileSize.
 */
function parseRangeSize(
  rangeHeader: string | undefined,
  fileSize: bigint,
): bigint {
  if (!rangeHeader || !rangeHeader.startsWith('bytes=')) return fileSize;

  const rangeStr = rangeHeader.slice(6);
  if (rangeStr.includes(',')) return fileSize;

  const dashIndex = rangeStr.indexOf('-');
  if (dashIndex === -1) return fileSize;

  const startStr = rangeStr.slice(0, dashIndex);
  const endStr = rangeStr.slice(dashIndex + 1);

  if (startStr === '') {
    const suffixLen = Number(endStr);
    return Number.isNaN(suffixLen) || suffixLen <= 0
      ? fileSize
      : BigInt(Math.min(suffixLen, Number(fileSize)));
  }

  const start = Number(startStr);
  if (Number.isNaN(start) || start < 0) return fileSize;
  if (endStr === '') return fileSize - BigInt(start);

  const end = Number(endStr);
  if (Number.isNaN(end) || end < start) return fileSize;
  return BigInt(end - start + 1);
}

function formatResetAt(lastReset: Date): string {
  return new Date(lastReset.getTime() + 86_400_000).toISOString();
}

/**
 * BandwidthInterceptor — gắn vào route download/stream.
 *
 * Flow:
 *  1. Resolve fileId + parse Range header → estimatedSize
 *  2. Pre-check: dailyBandwidthUsed + estimatedSize > dailyBandwidthLimit → 429
 *  3. LOCK: increment optimistic (giữ chỗ quota, chặn concurrent overspend)
 *  4. Khi response đóng (finish hoặc client disconnect), reconcile:
 *     - Dùng socket.bytesWritten để biết exact bytes đã gửi
 *     - Refund phần thừa (locked - actual)
 *     - Per-file counters theo actual bytes
 */
@Injectable()
export class BandwidthInterceptor implements NestInterceptor {
  private readonly logger = new Logger(BandwidthInterceptor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cryptoService: CryptoService,
    private readonly reflector: Reflector,
    private readonly lockService: BandwidthLockService,
  ) {}

  async intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Promise<Observable<unknown>> {
    const isCheckOnly =
      this.reflector.get<boolean>(
        'BANDWIDTH_CHECK_ONLY',
        context.getHandler(),
      ) || false;
    const req = context.switchToHttp().getRequest<ExpressRequest>();
    const res = context.switchToHttp().getResponse<ExpressResponse>();

    const { fileId, userId } = await this.resolveFileAndUser(req);
    if (!fileId) return next.handle();

    const file = await this.prisma.fileRecord.findUnique({
      where: { id: fileId },
      select: {
        size: true,
        downloadLimit24h: true,
        downloads24h: true,
        bandwidthLimit24h: true,
        bandwidthUsed24h: true,
        lastDownloadReset: true,
      },
    });
    if (!file) return next.handle();

    // Per-file quota check
    this.checkFileQuota(file, isCheckOnly, fileId, res);

    if (isCheckOnly) return next.handle();

    // Parse Range → lock only the requested bytes
    const estimatedSize = parseRangeSize(req.headers.range, file.size);
    const ip = getClientIp(req);

    try {
      const { requiresReset } = await this.lockService.lockBandwidth(
        userId,
        estimatedSize,
        ip,
      );
      this.attachReconcileListener(res, {
        fileId,
        userId: userId ?? null,
        estimatedSize,
        requiresReset,
        ip,
      });
    } catch (err: unknown) {
      if (err instanceof Error && err.message.includes('BANDWIDTH_LIMIT')) {
        const [code, resetAt] = err.message.split(':');
        res.setHeader('X-Bandwidth-Reset', resetAt);
        throw new HttpException(
          { code, resetAt },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
      throw err;
    }

    return next.handle();
  }

  private async resolveFileAndUser(
    req: ExpressRequest,
  ): Promise<{ fileId?: string; userId?: string }> {
    let fileId: string | undefined = req.params?.id ?? req.params?.fileId;
    let userId = req.user?.userId as string | undefined;

    if (
      !userId &&
      req.cookies &&
      typeof req.cookies === 'object' &&
      req.cookies.stream_token
    ) {
      const payload = this.cryptoService.verifyStreamCookieToken(
        req.cookies.stream_token,
      );
      if (payload?.sub && !payload.sub.startsWith('guest:'))
        userId = payload.sub;
    }

    if (!fileId && req.params?.token) {
      const payload = this.cryptoService.verifySignedToken(req.params.token);
      if (payload) {
        fileId = payload.fid;
        if (payload.uid) userId = payload.uid;
      }
    }

    if (!fileId) {
      const shareToken = req.params?.shareToken ?? req.params?.token;
      if (shareToken) {
        const file = await this.prisma.fileRecord.findUnique({
          where: { shareToken },
          select: { id: true },
        });
        if (file) fileId = file.id;
      }
    }

    return { fileId, userId };
  }

  private checkFileQuota(
    file: {
      size: bigint;
      downloadLimit24h: number | null;
      downloads24h: number;
      bandwidthLimit24h: bigint | null;
      bandwidthUsed24h: bigint;
      lastDownloadReset: Date;
    },
    isCheckOnly: boolean,
    fileId: string,
    res: ExpressResponse,
  ): void {
    const now = new Date();
    const hoursSinceReset =
      (now.getTime() - file.lastDownloadReset.getTime()) / 3_600_000;

    if (hoursSinceReset >= 24 && !isCheckOnly) {
      this.prisma.fileRecord
        .update({
          where: { id: fileId },
          data: {
            downloads24h: 0,
            bandwidthUsed24h: 0,
            lastDownloadReset: now,
          },
        })
        .catch(() => {});
      return;
    }

    const resetAt = formatResetAt(file.lastDownloadReset);
    if (
      file.downloadLimit24h !== null &&
      file.downloads24h >= file.downloadLimit24h
    ) {
      res.setHeader('X-Bandwidth-Reset', resetAt);
      throw new HttpException(
        { code: 'FILE_DOWNLOAD_LIMIT', resetAt },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    if (
      file.bandwidthLimit24h !== null &&
      file.bandwidthUsed24h + file.size > file.bandwidthLimit24h
    ) {
      res.setHeader('X-Bandwidth-Reset', resetAt);
      throw new HttpException(
        { code: 'FILE_BANDWIDTH_LIMIT', resetAt },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  private attachReconcileListener(
    res: ExpressResponse,
    data: BandwidthReconcileData,
  ): void {
    res.on('close', () => {
      if (res._bwReconciled) return;
      res._bwReconciled = true;

      const actualBytes =
        res.socket?.bytesWritten !== undefined
          ? BigInt(res.socket.bytesWritten)
          : 0n;

      if (actualBytes < data.estimatedSize) {
        const refund = data.estimatedSize - actualBytes;
        void this.lockService.refundBandwidth(
          {
            userId: data.userId,
            estimatedSize: data.estimatedSize,
            ip: data.ip,
          },
          refund,
          data.requiresReset,
        );
      }
      void this.lockService.reconcilePerFileCounters(
        data.fileId,
        actualBytes,
        data.estimatedSize,
      );
    });
  }
}
