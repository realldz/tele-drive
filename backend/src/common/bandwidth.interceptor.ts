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
  countAsDownload: boolean;
  method?: string;
  url?: string;
  range?: string;
}

interface FileBandwidthAggregate {
  fileId: string;
  actorKey: string;
  startedAt: number;
  lastUpdatedAt: number;
  requestCount: number;
  fullRequests: number;
  rangeRequests: number;
  zeroByteRequests: number;
  totalLocked: bigint;
  totalActual: bigint;
  totalRefunded: bigint;
}

type ExpressRequest = {
  params?: Record<string, string>;
  user?: Record<string, unknown>;
  cookies?: Record<string, string>;
  query?: Record<string, string | string[] | undefined>;
  headers: Record<string, string | undefined>;
  path?: string;
  requestId?: string;
  s3UserId?: string;
  s3PublicAccess?: boolean;
};

type ExpressResponse = {
  on: (event: string, cb: () => void) => void;
  getHeader: (name: string) => string | number | undefined;
  setHeader: (name: string, value: string) => void;
  write: (...args: unknown[]) => boolean;
  end: (...args: unknown[]) => unknown;
  _bwReconciled?: boolean;
  _header?: string;
  socket?: { bytesWritten?: number };
};

interface ResponseByteCounter {
  countedBytes: bigint;
  socketStartBytes: bigint | null;
  restore: () => void;
}

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

function formatBytes(bytes: bigint): string {
  const num = Number(bytes);
  if (num >= 1_073_741_824) return `${(num / 1_073_741_824).toFixed(2)} GB`;
  if (num >= 1_048_576) return `${(num / 1_048_576).toFixed(2)} MB`;
  if (num >= 1_024) return `${(num / 1_024).toFixed(2)} KB`;
  return `${num} B`;
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
  private readonly aggregateWindowMs = 30_000;
  private readonly bandwidthAggregates = new Map<
    string,
    FileBandwidthAggregate
  >();

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

    const estimatedSize = parseRangeSize(req.headers.range, file.size);

    // Per-file quota check
    try {
      this.checkFileQuota(file, estimatedSize, isCheckOnly, fileId, res);
    } catch (err) {
      if (err instanceof HttpException) {
        this.logger.warn(
          `[${req.requestId || 'unknown'}] Per-file quota exceeded: fileId=${fileId}, userId=${userId || 'guest'}, code=${err.message}`,
        );
      }
      throw err;
    }

    if (isCheckOnly) return next.handle();

    // Parse Range → lock only the requested bytes
    const ip = getClientIp(req);

    try {
      const { requiresReset } = await this.lockService.lockBandwidth(
        userId,
        estimatedSize,
        ip,
      );
      this.logger.debug(
        `[${req.requestId || 'unknown'}] Bandwidth locked: userId=${userId || 'guest'}, ip=${ip}, locked=${formatBytes(estimatedSize)}, fileId=${fileId}`,
      );
      this.attachReconcileListener(
        res,
        {
          fileId,
          userId: userId ?? null,
          estimatedSize,
          requiresReset,
          ip,
          countAsDownload: !req.headers.range,
          method: (req as { method?: string }).method,
          url:
            (req as { originalUrl?: string }).originalUrl ??
            (req as { url?: string }).url,
          range: req.headers.range,
        },
        req.requestId,
      );
    } catch (err: unknown) {
      if (err instanceof Error && err.message.includes('BANDWIDTH_LIMIT')) {
        const [code, resetAt] = err.message.split(':');
        res.setHeader('X-Bandwidth-Reset', resetAt);
        this.logger.warn(
          `[${req.requestId || 'unknown'}] Bandwidth limit exceeded: userId=${userId || 'guest'}, ip=${ip}, estimated=${formatBytes(estimatedSize)}`,
        );
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

    if (!fileId && req.s3UserId && !this.hasS3UploadId(req)) {
      const s3File = await this.resolveS3Object(req.s3UserId, req);
      if (s3File) {
        fileId = s3File.id;
        if (!req.s3PublicAccess) {
          userId = req.s3UserId;
        }
      }
    }

    return { fileId, userId };
  }

  private hasS3UploadId(req: ExpressRequest): boolean {
    const uploadId = req.query?.uploadId;
    if (Array.isArray(uploadId)) return uploadId.length > 0;
    return typeof uploadId === 'string' && uploadId.length > 0;
  }

  private getS3ObjectKey(req: ExpressRequest): string | null {
    const bucket = req.params?.bucket;
    if (!bucket) return null;

    const path = req.path || '';
    const base = `/s3/${bucket}/`;
    if (path.startsWith(base)) {
      const rawKey = path.substring(base.length);
      if (rawKey.length > 0) return decodeURIComponent(rawKey);
    }

    const paramKey = req.params?.key;
    return paramKey ? String(paramKey) : null;
  }

  private async resolveS3Object(
    userId: string,
    req: ExpressRequest,
  ): Promise<{ id: string } | null> {
    const bucket = req.params?.bucket;
    const key = this.getS3ObjectKey(req);
    if (!bucket || !key) return null;

    const parts = key.split('/').filter(Boolean);
    if (parts.length === 0) return null;

    const bucketFolder = await this.prisma.folder.findFirst({
      where: { userId, name: bucket, parentId: null, deletedAt: null },
      select: { id: true },
    });
    if (!bucketFolder) return null;

    let currentFolderId = bucketFolder.id;
    for (const part of parts.slice(0, -1)) {
      const folder = await this.prisma.folder.findFirst({
        where: {
          name: part,
          parentId: currentFolderId,
          userId,
          deletedAt: null,
        },
        select: { id: true },
      });
      if (!folder) return null;
      currentFolderId = folder.id;
    }

    const filename = parts[parts.length - 1];
    return this.prisma.fileRecord.findFirst({
      where: {
        folderId: currentFolderId,
        filename,
        userId,
        deletedAt: null,
        status: 'complete',
      },
      select: { id: true },
    });
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
    estimatedSize: bigint,
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
      file.bandwidthUsed24h + estimatedSize > file.bandwidthLimit24h
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
    requestId?: string,
  ): void {
    const counter = this.attachResponseByteCounter(res);
    res.on('close', () => {
      if (res._bwReconciled) return;
      res._bwReconciled = true;
      counter.restore();

      const contentLengthHeader = res.getHeader('content-length');
      const actualBytes = this.resolveActualBytes(
        res,
        counter.countedBytes,
        counter.socketStartBytes,
        data.estimatedSize,
      );

      this.logger.debug(
        `[${requestId || 'unknown'}] Bandwidth response details: method=${data.method || 'unknown'}, url=${data.url || 'unknown'}, range=${data.range || '-'}, contentLength=${contentLengthHeader ?? '-'}, counted=${formatBytes(counter.countedBytes)}, socketStart=${counter.socketStartBytes === null ? '-' : counter.socketStartBytes.toString()}, socketEnd=${typeof res.socket?.bytesWritten === 'number' ? String(res.socket.bytesWritten) : '-'}, headerBytes=${formatBytes(this.estimateHeaderBytes(res))}, actual=${formatBytes(actualBytes)}, countAsDownload=${data.countAsDownload}`,
      );

      const refund =
        actualBytes < data.estimatedSize
          ? data.estimatedSize - actualBytes
          : 0n;

      if (refund > 0n) {
        void this.lockService.refundBandwidth(
          {
            userId: data.userId,
            estimatedSize: data.estimatedSize,
            ip: data.ip,
          },
          refund,
          data.requiresReset,
        );
        this.logger.debug(
          `[${requestId || 'unknown'}] Bandwidth reconciled: fileId=${data.fileId}, userId=${data.userId || 'guest'}, locked=${formatBytes(data.estimatedSize)}, actual=${formatBytes(actualBytes)}, refunded=${formatBytes(refund)}`,
        );
      } else {
        this.logger.debug(
          `[${requestId || 'unknown'}] Bandwidth reconciled: fileId=${data.fileId}, userId=${data.userId || 'guest'}, locked=${formatBytes(data.estimatedSize)}, actual=${formatBytes(actualBytes)}, refunded=0 B`,
        );
      }
      void this.lockService.reconcilePerFileCounters(
        data.fileId,
        actualBytes,
        data.estimatedSize,
        data.countAsDownload,
      );
      this.recordAggregate(data, actualBytes, refund, requestId);
    });
  }

  private recordAggregate(
    data: BandwidthReconcileData,
    actualBytes: bigint,
    refund: bigint,
    requestId?: string,
  ): void {
    const now = Date.now();
    this.pruneAggregates(now);

    const actorKey = data.userId ?? `guest:${data.ip}`;
    const aggregateKey = `${data.fileId}:${actorKey}`;
    const existing = this.bandwidthAggregates.get(aggregateKey);

    const aggregate: FileBandwidthAggregate =
      existing && now - existing.lastUpdatedAt < this.aggregateWindowMs
        ? existing
        : {
            fileId: data.fileId,
            actorKey,
            startedAt: now,
            lastUpdatedAt: now,
            requestCount: 0,
            fullRequests: 0,
            rangeRequests: 0,
            zeroByteRequests: 0,
            totalLocked: 0n,
            totalActual: 0n,
            totalRefunded: 0n,
          };

    aggregate.lastUpdatedAt = now;
    aggregate.requestCount += 1;
    aggregate.totalLocked += data.estimatedSize;
    aggregate.totalActual += actualBytes;
    aggregate.totalRefunded += refund;
    if (data.range) {
      aggregate.rangeRequests += 1;
    } else {
      aggregate.fullRequests += 1;
    }
    if (actualBytes === 0n) {
      aggregate.zeroByteRequests += 1;
    }

    this.bandwidthAggregates.set(aggregateKey, aggregate);

    this.logger.debug(
      `[${requestId || 'unknown'}] Bandwidth aggregate: fileId=${aggregate.fileId}, actor=${aggregate.actorKey}, windowMs=${now - aggregate.startedAt}, requests=${aggregate.requestCount}, full=${aggregate.fullRequests}, range=${aggregate.rangeRequests}, zero=${aggregate.zeroByteRequests}, locked=${formatBytes(aggregate.totalLocked)}, actual=${formatBytes(aggregate.totalActual)}, refunded=${formatBytes(aggregate.totalRefunded)}`,
    );
  }

  private pruneAggregates(now: number): void {
    for (const [key, aggregate] of this.bandwidthAggregates.entries()) {
      if (now - aggregate.lastUpdatedAt >= this.aggregateWindowMs) {
        this.bandwidthAggregates.delete(key);
      }
    }
  }

  private resolveActualBytes(
    res: ExpressResponse,
    countedBytes: bigint,
    socketStartBytes: bigint | null,
    estimatedSize: bigint,
  ): bigint {
    const socketPayloadBytes = this.getSocketPayloadBytes(
      res,
      socketStartBytes,
    );
    const measuredBytes = socketPayloadBytes ?? countedBytes;
    return measuredBytes < estimatedSize ? measuredBytes : estimatedSize;
  }

  private getSocketPayloadBytes(
    res: ExpressResponse,
    socketStartBytes: bigint | null,
  ): bigint | null {
    if (
      socketStartBytes === null ||
      typeof res.socket?.bytesWritten !== 'number' ||
      !Number.isFinite(res.socket.bytesWritten)
    ) {
      return null;
    }

    const socketEndBytes = BigInt(
      Math.max(0, Math.trunc(res.socket.bytesWritten)),
    );
    if (socketEndBytes <= socketStartBytes) {
      return 0n;
    }

    const socketDelta = socketEndBytes - socketStartBytes;
    const headerBytes = this.estimateHeaderBytes(res);
    if (socketDelta <= headerBytes) {
      return 0n;
    }

    return socketDelta - headerBytes;
  }

  private estimateHeaderBytes(res: ExpressResponse): bigint {
    const header = res._header;
    if (typeof header !== 'string' || header.length === 0) {
      return 0n;
    }

    return BigInt(Buffer.byteLength(header, 'utf8'));
  }

  private attachResponseByteCounter(res: ExpressResponse): ResponseByteCounter {
    let countedBytes = 0n;
    const socketStartBytes =
      typeof res.socket?.bytesWritten === 'number' &&
      Number.isFinite(res.socket.bytesWritten)
        ? BigInt(Math.max(0, Math.trunc(res.socket.bytesWritten)))
        : null;
    const originalWrite = res.write.bind(res);
    const originalEnd = res.end.bind(res);

    const countChunk = (chunk: unknown, encoding?: unknown): void => {
      if (chunk === undefined || chunk === null) return;
      if (typeof chunk === 'string') {
        countedBytes += BigInt(
          Buffer.byteLength(chunk, this.normalizeEncoding(encoding)),
        );
        return;
      }
      if (Buffer.isBuffer(chunk)) {
        countedBytes += BigInt(chunk.length);
        return;
      }
      if (chunk instanceof Uint8Array) {
        countedBytes += BigInt(chunk.byteLength);
      }
    };

    res.write = ((chunk: unknown, encoding?: unknown, cb?: unknown) => {
      countChunk(chunk, encoding);
      return originalWrite(chunk, encoding, cb);
    }) as ExpressResponse['write'];

    res.end = ((chunk?: unknown, encoding?: unknown, cb?: unknown) => {
      countChunk(chunk, encoding);
      return originalEnd(chunk, encoding, cb);
    }) as ExpressResponse['end'];

    return {
      get countedBytes() {
        return countedBytes;
      },
      socketStartBytes,
      restore: () => {
        res.write = originalWrite;
        res.end = originalEnd;
      },
    };
  }

  private normalizeEncoding(encoding: unknown): BufferEncoding | undefined {
    if (typeof encoding !== 'string') return undefined;
    switch (encoding) {
      case 'ascii':
      case 'utf8':
      case 'utf16le':
      case 'ucs2':
      case 'base64':
      case 'base64url':
      case 'latin1':
      case 'binary':
      case 'hex':
        return encoding;
      case 'utf-8':
        return 'utf8';
      case 'ucs-2':
        return 'ucs2';
      default:
        return undefined;
    }
  }
}
