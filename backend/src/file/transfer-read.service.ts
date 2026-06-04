import {
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  UnauthorizedException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { TelegramService, fetchWithRetry } from '../telegram/telegram.service';
import { Readable, Transform } from 'stream';
import type { Response } from 'express';
import { CryptoService } from '../crypto/crypto.service';
import { SettingsService } from '../settings/settings.service';
import type {
  DownloadInfo,
  SingleFileDownloadInfo,
  ChunkedDownloadInfo,
} from '../common/types/download';
import { TEMP_STORAGE } from '../common/temp-storage';
import type { TempStorage } from '../common/temp-storage';

@Injectable()
export class TransferReadService {
  private readonly logger = new Logger(TransferReadService.name);
  private readonly PREFETCH_AHEAD = 2;

  constructor(
    private readonly prisma: PrismaService,
    private readonly telegram: TelegramService,
    private readonly cryptoService: CryptoService,
    private readonly settingsService: SettingsService,
    @Inject(TEMP_STORAGE) private readonly tempStorage: TempStorage,
  ) {}

  async isMultiThreadEnabled(): Promise<boolean> {
    return this.settingsService.getCachedSetting(
      'ENABLE_MULTI_THREAD_DOWNLOAD',
      true,
      (v) => v !== 'false',
    );
  }

  async getDownloadTtl(): Promise<number> {
    return this.settingsService.getCachedSetting(
      'DOWNLOAD_URL_TTL_SECONDS',
      300,
      (v) => parseInt(v, 10),
    );
  }

  async getStreamTtl(): Promise<number> {
    return this.settingsService.getCachedSetting(
      'STREAM_COOKIE_TTL_SECONDS',
      3600,
      (v) => parseInt(v, 10),
    );
  }

  async generateDownloadToken(
    fileId: string,
    userId: string,
  ): Promise<{ url: string; expiresAt: string }> {
    const file = await this.prisma.fileRecord.findFirst({
      where: {
        id: fileId,
        userId,
        status: { in: ['complete', 'buffered'] },
        deletedAt: null,
      },
      select: { id: true },
    });
    if (!file) throw new NotFoundException('File not found');

    const ttl = await this.getDownloadTtl();
    const token = this.cryptoService.createSignedToken(
      fileId,
      'u',
      ttl,
      userId,
    );
    const expiresAt = new Date(Date.now() + ttl * 1000).toISOString();

    this.logger.debug(
      `Download token generated: fileId=${fileId}, userId=${userId}, ttl=${ttl}s`,
    );
    return { url: `/files/d/${token}`, expiresAt };
  }

  async generateShareDownloadToken(
    shareToken: string,
  ): Promise<{ url: string; expiresAt: string }> {
    const file = await this.prisma.fileRecord.findUnique({
      where: { shareToken },
      select: { id: true, status: true, deletedAt: true },
    });
    if (!file || file.deletedAt) {
      throw new NotFoundException('Shared file not found');
    }
    if (file.status !== 'complete' && file.status !== 'buffered') {
      throw new BadRequestException('File upload not completed yet');
    }

    const ttl = await this.getDownloadTtl();
    const token = this.cryptoService.createSignedToken(file.id, 's', ttl);
    const expiresAt = new Date(Date.now() + ttl * 1000).toISOString();

    this.logger.debug(
      `Share download token generated: shareToken=${shareToken}, fileId=${file.id}, ttl=${ttl}s`,
    );
    return { url: `/files/d/${token}`, expiresAt };
  }

  async downloadBySignedToken(signedToken: string): Promise<DownloadInfo> {
    const payload = this.cryptoService.verifySignedToken(signedToken);
    if (!payload) {
      throw new UnauthorizedException('Invalid or expired download link');
    }

    const fileRecord = await this.prisma.fileRecord.findFirst({
      where: {
        id: payload.fid,
        status: { in: ['complete', 'buffered'] },
        deletedAt: null,
      },
      include: { chunks: { orderBy: { chunkIndex: 'asc' } } },
    });
    if (!fileRecord) throw new NotFoundException('File not found');

    return this.getDownloadMetadata(fileRecord);
  }

  async getStreamInfoByOwner(
    fileId: string,
    cookieSubject: string,
  ): Promise<DownloadInfo> {
    const fileRecord = await this.prisma.fileRecord.findFirst({
      where: {
        id: fileId,
        userId: cookieSubject,
        status: { in: ['complete', 'buffered'] },
        deletedAt: null,
      },
      include: { chunks: { orderBy: { chunkIndex: 'asc' } } },
    });
    if (!fileRecord) throw new NotFoundException('File not found');

    return this.getDownloadMetadata(fileRecord);
  }

  async getShareStreamInfo(shareToken: string): Promise<DownloadInfo> {
    return this.getDownloadInfoByToken(shareToken);
  }

  async getStreamInfoByGuest(fileId: string): Promise<DownloadInfo> {
    const fileRecord = await this.prisma.fileRecord.findFirst({
      where: {
        id: fileId,
        status: { in: ['complete', 'buffered'] },
        deletedAt: null,
        visibility: 'PUBLIC_LINK',
      },
      include: { chunks: { orderBy: { chunkIndex: 'asc' } } },
    });
    if (!fileRecord) {
      throw new NotFoundException('File not found or not shared');
    }

    return this.getDownloadMetadata(fileRecord);
  }

  async getDownloadInfo(id: string, userId: string): Promise<DownloadInfo> {
    const fileRecord = await this.prisma.fileRecord.findFirst({
      where: { id, userId, deletedAt: null },
      include: { chunks: { orderBy: { chunkIndex: 'asc' } } },
    });
    if (!fileRecord) throw new NotFoundException('File not found');
    if (fileRecord.status !== 'complete' && fileRecord.status !== 'buffered') {
      throw new BadRequestException('File upload not completed yet');
    }

    return this.getDownloadMetadata(fileRecord);
  }

  async getDownloadInfoByToken(token: string): Promise<DownloadInfo> {
    const fileRecord = await this.prisma.fileRecord.findUnique({
      where: { shareToken: token },
      include: { chunks: { orderBy: { chunkIndex: 'asc' } } },
    });
    if (!fileRecord || fileRecord.deletedAt) {
      throw new NotFoundException('Shared file not found');
    }
    if (fileRecord.status !== 'complete' && fileRecord.status !== 'buffered') {
      throw new BadRequestException('File upload not completed yet');
    }

    return this.getDownloadMetadata(fileRecord);
  }

  getDownloadMetadata(fileRecord: {
    filename: string;
    size: bigint | number;
    telegramFileId: string | null;
    botId: bigint;
    telegramMessageId: number | null;
    isChunked: boolean;
    isEncrypted: boolean;
    encryptedKey: string | null;
    encryptionIv: string | null;
    mimeType: string;
    status: string;
    tempStorageKey: string | null;
    chunks: Array<{
      id: string;
      telegramFileId: string | null;
      botId: bigint;
      telegramMessageId: number | null;
      encryptionIv: string | null;
      size: number | bigint;
      status?: string;
      tempStorageKey?: string | null;
    }>;
  }): DownloadInfo {
    let dek: Buffer | null = null;
    if (fileRecord.isEncrypted && fileRecord.encryptedKey) {
      dek = this.cryptoService.decryptKey(fileRecord.encryptedKey);
    }

    if (fileRecord.status === 'buffered' && fileRecord.tempStorageKey) {
      return {
        filename: fileRecord.filename,
        size: fileRecord.size,
        isBuffered: true,
        tempStorageKey: fileRecord.tempStorageKey,
        mimeType: fileRecord.mimeType,
        isChunked: false,
      };
    }

    if (!fileRecord.isChunked && fileRecord.telegramFileId) {
      return {
        filename: fileRecord.filename,
        size: fileRecord.size,
        telegramFileId: fileRecord.telegramFileId,
        botId: fileRecord.botId,
        telegramMessageId: fileRecord.telegramMessageId,
        isEncrypted: fileRecord.isEncrypted,
        dek,
        iv: fileRecord.encryptionIv
          ? Buffer.from(fileRecord.encryptionIv, 'hex')
          : null,
        mimeType: fileRecord.mimeType,
      };
    }

    const chunks = fileRecord.chunks.map((chunk) => ({
      id: chunk.id,
      telegramFileId: chunk.telegramFileId,
      botId: chunk.botId,
      telegramMessageId: chunk.telegramMessageId,
      iv: chunk.encryptionIv ? Buffer.from(chunk.encryptionIv, 'hex') : null,
      size: Number(chunk.size),
      isBuffered: chunk.status === 'buffered',
      tempStorageKey: chunk.tempStorageKey,
    }));

    return {
      filename: fileRecord.filename,
      size: fileRecord.size,
      isChunked: true,
      chunks,
      isEncrypted: fileRecord.isEncrypted,
      dek,
      mimeType: fileRecord.mimeType,
    };
  }

  private async resolveFileLink(
    telegramFileId: string,
    botId: bigint,
    telegramMessageId: number | null,
    chunkDbId: string | null,
    context?: string,
  ): Promise<string> {
    // 1. If the uploader bot is in the map, use it directly
    if (this.telegram.isBotAvailable(botId)) {
      return this.telegram.getFileLink(telegramFileId, botId, context);
    }

    // 2. Bot not in map — try getFileLink via main bot fallback
    //    (Local Bot API servers share file access across all bots)
    this.logger.debug(
      `Bot ${botId} not in map, trying main bot fallback for fileId: ${telegramFileId}`,
    );
    try {
      return await this.telegram.getFileLink(
        telegramFileId,
        this.telegram.mainBotTelegramId,
        context,
      );
    } catch {
      // Main bot can't access this file_id either — need recovery
    }

    // 3. Expensive recovery: forward original message to get a new file_id
    if (!telegramMessageId) {
      throw new Error(`Bot ${botId} unavailable and no messageId for recovery`);
    }
    this.logger.warn(
      `Bot ${botId} unavailable, recovering via forward (messageId: ${telegramMessageId})`,
    );
    const { fileId: newFileId, botId: newBotId } =
      await this.telegram.recoverFileId(telegramMessageId);
    if (chunkDbId) {
      this.prisma.fileChunk
        .update({
          where: { id: chunkDbId },
          data: { telegramFileId: newFileId, botId: newBotId },
        })
        .catch((e) =>
          this.logger.warn(`Failed to update recovered chunk: ${e.message}`),
        );
    }
    return this.telegram.getFileLink(newFileId, newBotId, context);
  }

  private pipeStreamToResponse(
    fetchBody: ReadableStream | Readable,
    res: Response,
    options: {
      decrypt?: { dek: Buffer; iv: Buffer; offset?: number };
      endResponse?: boolean;
    } = {},
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const rawStream =
        typeof (fetchBody as any).getReader === 'function'
          ? Readable.fromWeb(fetchBody as any)
          : (fetchBody as Readable);
      rawStream.on('error', (err) => {
        if (!res.destroyed) res.end();
        reject(err);
      });

      let output: Readable | Transform = rawStream;
      if (options.decrypt) {
        const decryptStream =
          options.decrypt.offset !== undefined
            ? this.cryptoService.createOffsetDecryptStream(
                options.decrypt.dek,
                options.decrypt.iv,
                options.decrypt.offset,
              )
            : this.cryptoService.createDecryptStream(
                options.decrypt.dek,
                options.decrypt.iv,
              );
        decryptStream.on('error', (err) => {
          rawStream.destroy();
          if (!res.destroyed) res.end();
          reject(err);
        });
        output = rawStream.pipe(decryptStream);
      }

      output.on('end', () => resolve());
      output.on('error', reject);

      const onResClose = () => {
        if (!res.writableFinished) {
          rawStream.destroy();
        }
      };
      res.on('close', onResClose);
      output.pipe(res, { end: options.endResponse ?? false });

      const cleanup = () => res.removeListener('close', onResClose);
      output.on('end', cleanup);
      output.on('error', cleanup);
    });
  }

  private isClientDisconnect(err: unknown): boolean {
    if (err instanceof Error) {
      const code = (err as NodeJS.ErrnoException).code;
      return (
        code === 'ECONNRESET' ||
        err.message === 'terminated' ||
        code === 'ERR_STREAM_PREMATURE_CLOSE'
      );
    }
    return false;
  }

  async processDownload(
    downloadInfo: DownloadInfo,
    res: Response,
    rangeHeader?: string,
  ) {
    if (rangeHeader && (await this.isMultiThreadEnabled())) {
      return this.processRangeDownload(downloadInfo, rangeHeader, res);
    }

    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${encodeURIComponent(downloadInfo.filename)}"`,
    );
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Length', downloadInfo.size.toString());
    if (await this.isMultiThreadEnabled()) {
      res.setHeader('Accept-Ranges', 'bytes');
    }

    if ('isBuffered' in downloadInfo && downloadInfo.isBuffered) {
      try {
        const stream = await this.tempStorage.read(downloadInfo.tempStorageKey);
        await this.pipeStreamToResponse(stream, res, {
          endResponse: true,
        });
      } catch (err: unknown) {
        if (this.isClientDisconnect(err)) {
          this.logger.debug(
            `Client disconnected during download: "${downloadInfo.filename}"`,
          );
        } else {
          this.logger.error(
            `Download failed: "${downloadInfo.filename}"`,
            err instanceof Error ? err.message : String(err),
          );
          if (!res.headersSent) res.status(500).end();
          else if (!res.destroyed) res.end();
        }
      }
      return;
    }

    const info = downloadInfo as SingleFileDownloadInfo | ChunkedDownloadInfo;

    if (!info.isChunked) {
      const url = await this.resolveFileLink(
        info.telegramFileId,
        info.botId,
        info.telegramMessageId,
        null,
      );
      const fetchRes = await fetchWithRetry(url);
      if (!fetchRes.ok || !fetchRes.body) {
        this.logger.error(
          `Failed to fetch file from Telegram: "${info.filename}" (status: ${fetchRes.status}, url: ${url})`,
        );
        res.status(500).send('Trich xuat file tu Telegram that bai');
        return;
      }

      try {
        await this.pipeStreamToResponse(fetchRes.body, res, {
          decrypt:
            info.isEncrypted && info.dek && info.iv
              ? { dek: info.dek, iv: info.iv }
              : undefined,
          endResponse: true,
        });
      } catch (err: unknown) {
        if (this.isClientDisconnect(err)) {
          this.logger.debug(
            `Client disconnected during download: "${info.filename}"`,
          );
        } else {
          this.logger.error(
            `Download failed: "${info.filename}"`,
            err instanceof Error ? err.message : String(err),
          );
          if (!res.headersSent) res.status(500).end();
          else if (!res.destroyed) res.end();
        }
      }
      return;
    }

    try {
      const chunks = info.chunks;
      const totalChunks = chunks.length;

      for (let i = 0; i < totalChunks; i++) {
        for (
          let p = i + 1;
          p < Math.min(i + 1 + this.PREFETCH_AHEAD, totalChunks);
          p++
        ) {
          if (!chunks[p].isBuffered) {
            void this.resolveFileLink(
              chunks[p].telegramFileId!,
              chunks[p].botId,
              chunks[p].telegramMessageId,
              chunks[p].id,
              `prefetch chunk ${p + 1}/${totalChunks} of "${info.filename}"`,
            );
          }
        }

        let chunkStream: Readable;
        const key = chunks[i].tempStorageKey;
        if (chunks[i].isBuffered && key) {
          chunkStream = await this.tempStorage.read(key);
        } else {
          const url = await this.resolveFileLink(
            chunks[i].telegramFileId!,
            chunks[i].botId,
            chunks[i].telegramMessageId,
            chunks[i].id,
            `chunk ${i + 1}/${totalChunks} of "${info.filename}"`,
          );

          const fetchRes = await fetchWithRetry(url);
          if (!fetchRes.ok || !fetchRes.body) {
            throw new Error(
              `Failed to fetch chunk ${i + 1}/${totalChunks} from Telegram`,
            );
          }
          chunkStream = Readable.fromWeb(fetchRes.body as any);
        }

        await this.pipeStreamToResponse(chunkStream, res, {
          decrypt:
            !chunks[i].isBuffered &&
            info.isEncrypted &&
            info.dek &&
            chunks[i].iv
              ? { dek: info.dek, iv: chunks[i].iv! }
              : undefined,
        });
      }
      res.end();
    } catch (error: unknown) {
      if (this.isClientDisconnect(error)) {
        this.logger.debug(
          `Client disconnected during chunked download: "${info.filename}"`,
        );
      } else {
        this.logger.error(
          `Chunked download failed: "${info.filename}"`,
          error instanceof Error ? error.stack : String(error),
        );
        if (!res.headersSent) {
          res.status(500).send('Loi khi ghep file tu Telegram');
        } else if (!res.destroyed) {
          res.end();
        }
      }
    }
  }

  async processStream(
    downloadInfo: DownloadInfo,
    rangeHeader: string | undefined,
    res: Response,
  ) {
    return this.processRangeRequest(downloadInfo, rangeHeader, res, 'inline');
  }

  private async processRangeDownload(
    downloadInfo: DownloadInfo,
    rangeHeader: string,
    res: Response,
  ) {
    return this.processRangeRequest(
      downloadInfo,
      rangeHeader,
      res,
      'attachment',
    );
  }

  private async processRangeRequest(
    downloadInfo: DownloadInfo,
    rangeHeader: string | undefined,
    res: Response,
    disposition: 'inline' | 'attachment',
  ) {
    const fileSize = Number(downloadInfo.size);
    let start = 0;
    let end = fileSize - 1;

    if (rangeHeader) {
      const match = rangeHeader.match(/bytes=(\d+)-(\d*)/);
      if (match) {
        start = parseInt(match[1], 10);
        if (match[2]) {
          end = parseInt(match[2], 10);
        }
      }
    }

    if (start >= fileSize) {
      res.status(416).setHeader('Content-Range', `bytes */${fileSize}`);
      return res.end();
    }

    end = Math.min(end, fileSize - 1);
    const contentLength = end - start + 1;

    if (rangeHeader) {
      res.status(206);
      res.setHeader('Content-Range', `bytes ${start}-${end}/${fileSize}`);
    } else {
      res.status(200);
    }
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Length', contentLength.toString());
    res.setHeader(
      'Content-Type',
      downloadInfo.mimeType || 'application/octet-stream',
    );
    if (disposition === 'attachment') {
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${encodeURIComponent(downloadInfo.filename)}"`,
      );
    } else {
      res.setHeader('Content-Disposition', 'inline');
    }

    if ('isBuffered' in downloadInfo && downloadInfo.isBuffered) {
      try {
        const stream = await this.tempStorage.read(
          downloadInfo.tempStorageKey,
          {
            start,
            end,
          },
        );
        await this.pipeStreamToResponse(stream, res, {
          endResponse: true,
        });
      } catch (err: unknown) {
        if (this.isClientDisconnect(err)) {
          this.logger.debug(
            `Client disconnected during ${disposition}: "${downloadInfo.filename}"`,
          );
        } else {
          this.logger.error(
            `${disposition} failed: "${downloadInfo.filename}"`,
            err instanceof Error ? err.message : String(err),
          );
          if (!res.headersSent) res.status(500).end();
          else if (!res.destroyed) res.end();
        }
      }
      return;
    }

    const info = downloadInfo as SingleFileDownloadInfo | ChunkedDownloadInfo;

    if (!info.isChunked) {
      const url = await this.resolveFileLink(
        info.telegramFileId,
        info.botId,
        info.telegramMessageId,
        null,
      );
      const fetchRes = await fetchWithRetry(url, {
        headers: { Range: `bytes=${start}-${end}` },
      });
      if (!fetchRes.ok || !fetchRes.body) {
        this.logger.error(`Failed to fetch from Telegram: "${info.filename}"`);
        return res.status(500).end();
      }

      try {
        await this.pipeStreamToResponse(fetchRes.body, res, {
          decrypt:
            info.isEncrypted && info.dek && info.iv
              ? { dek: info.dek, iv: info.iv, offset: start }
              : undefined,
          endResponse: true,
        });
      } catch (err: unknown) {
        if (this.isClientDisconnect(err)) {
          this.logger.debug(
            `Client disconnected during ${disposition}: "${info.filename}"`,
          );
        } else {
          this.logger.error(
            `${disposition} failed: "${info.filename}"`,
            err instanceof Error ? err.message : String(err),
          );
          if (!res.headersSent) res.status(500).end();
          else if (!res.destroyed) res.end();
        }
      }
      return;
    }

    let currentOffset = 0;
    const chunksToFetch: {
      telegramFileId: string | null;
      botId: bigint;
      telegramMessageId: number | null;
      id: string | null;
      iv: Buffer | null;
      size: number;
      fetchStart: number;
      fetchEnd: number;
      byteOffsetInChunk: number;
      isBuffered: boolean;
      tempStorageKey: string | null;
    }[] = [];

    for (const chunk of info.chunks) {
      const chunkStart = currentOffset;
      const chunkEnd = currentOffset + chunk.size - 1;

      if (start <= chunkEnd && end >= chunkStart) {
        const fetchStart = Math.max(start, chunkStart) - chunkStart;
        const fetchEnd = Math.min(end, chunkEnd) - chunkStart;

        chunksToFetch.push({
          telegramFileId: chunk.telegramFileId,
          botId: chunk.botId,
          telegramMessageId: chunk.telegramMessageId,
          id: chunk.id,
          iv: chunk.iv,
          size: chunk.size,
          fetchStart,
          fetchEnd,
          byteOffsetInChunk: fetchStart,
          isBuffered: !!chunk.isBuffered,
          tempStorageKey: chunk.tempStorageKey || null,
        });
      }
      currentOffset += chunk.size;
    }

    try {
      for (let i = 0; i < chunksToFetch.length; i++) {
        const chunkReq = chunksToFetch[i];

        for (
          let p = i + 1;
          p < Math.min(i + 1 + this.PREFETCH_AHEAD, chunksToFetch.length);
          p++
        ) {
          if (!chunksToFetch[p].isBuffered) {
            void this.resolveFileLink(
              chunksToFetch[p].telegramFileId!,
              chunksToFetch[p].botId,
              chunksToFetch[p].telegramMessageId,
              chunksToFetch[p].id,
            );
          }
        }

        let chunkStream: Readable;
        if (chunkReq.isBuffered && chunkReq.tempStorageKey) {
          chunkStream = await this.tempStorage.read(chunkReq.tempStorageKey, {
            start: chunkReq.fetchStart,
            end: chunkReq.fetchEnd,
          });
        } else {
          const url = await this.resolveFileLink(
            chunkReq.telegramFileId!,
            chunkReq.botId,
            chunkReq.telegramMessageId,
            chunkReq.id,
          );
          const fetchRes = await fetchWithRetry(url, {
            headers: {
              Range: `bytes=${chunkReq.fetchStart}-${chunkReq.fetchEnd}`,
            },
          });
          if (!fetchRes.ok || !fetchRes.body)
            throw new Error('Fetch chunk error');
          chunkStream = Readable.fromWeb(fetchRes.body as any);
        }

        await this.pipeStreamToResponse(chunkStream, res, {
          decrypt:
            !chunkReq.isBuffered && info.isEncrypted && info.dek && chunkReq.iv
              ? {
                  dek: info.dek,
                  iv: chunkReq.iv,
                  offset: chunkReq.byteOffsetInChunk,
                }
              : undefined,
        });
      }
      res.end();
    } catch (err: unknown) {
      if (this.isClientDisconnect(err)) {
        this.logger.debug(
          `Client disconnected during ${disposition}: "${info.filename}"`,
        );
      } else {
        this.logger.error(
          `${disposition} error: "${info.filename}"`,
          err instanceof Error ? err.message : String(err),
        );
      }
      if (!res.headersSent) res.status(500).end();
      else if (!res.destroyed) res.end();
    }
  }
}
