import { Injectable, Logger, NotFoundException, BadRequestException, HttpException, HttpStatus } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { TelegramService } from '../telegram/telegram.service';
import { fetchWithRetry } from '../telegram/telegram.service';
import { Transform, TransformCallback, Readable } from 'stream';
import Busboy from 'busboy';
import * as crypto from 'crypto';
import type { Response } from 'express';
import { CryptoService } from '../crypto/crypto.service';
import { MAX_CHUNK_SIZE } from '../config/upload.config';
import type { DownloadInfo } from '../common/types/download';

/**
 * Transform stream đếm bytes đi qua — dùng để biết kích thước chunk
 * mà không cần buffer toàn bộ vào memory.
 */
class ByteCounter extends Transform {
  public bytes = 0;
  _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback) {
    this.bytes += chunk.length;
    this.push(chunk);
    callback();
  }
}

@Injectable()
export class FileService {
  private readonly logger = new Logger(FileService.name);

  /** Cached multi-thread download setting */
  private multiThreadEnabled: boolean | null = null;
  private multiThreadEnabledAt = 0;

  /** Cached max concurrent chunks setting */
  private _maxConcurrentChunks: number | null = null;
  private _maxConcurrentChunksAt = 0;

  /** Track active chunk uploads per user for concurrency enforcement */
  private readonly activeUploads = new Map<string, number>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly telegram: TelegramService,
    private readonly cryptoService: CryptoService,
  ) {}

  /**
   * Kiểm tra setting ENABLE_MULTI_THREAD_DOWNLOAD (cache 30 giây)
   */
  async isMultiThreadEnabled(): Promise<boolean> {
    if (this.multiThreadEnabled !== null && Date.now() - this.multiThreadEnabledAt < 30_000) {
      return this.multiThreadEnabled;
    }
    const setting = await this.prisma.systemSetting.findUnique({
      where: { key: 'ENABLE_MULTI_THREAD_DOWNLOAD' },
    });
    this.multiThreadEnabled = setting?.value !== 'false';
    this.multiThreadEnabledAt = Date.now();
    return this.multiThreadEnabled;
  }

  /**
   * Kiểm tra setting MAX_CONCURRENT_CHUNKS (cache 30 giây)
   */
  async getMaxConcurrentChunks(): Promise<number> {
    if (this._maxConcurrentChunks !== null && Date.now() - this._maxConcurrentChunksAt < 30_000) {
      return this._maxConcurrentChunks;
    }
    const setting = await this.prisma.systemSetting.findUnique({
      where: { key: 'MAX_CONCURRENT_CHUNKS' },
    });
    this._maxConcurrentChunks = setting ? parseInt(setting.value, 10) || 3 : 3;
    this._maxConcurrentChunksAt = Date.now();
    return this._maxConcurrentChunks;
  }

  /**
   * Kiểm tra quota trước khi upload.
   * Throw 400 nếu usedSpace + fileSize > quota.
   */
  private async checkQuota(userId: string, fileSize: number | bigint): Promise<void> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { usedSpace: true, quota: true },
    });
    if (!user) throw new NotFoundException('User not found');

    const size = BigInt(fileSize);
    if (user.usedSpace + size > user.quota) {
      const usedMB = Number(user.usedSpace) / (1024 * 1024);
      const quotaMB = Number(user.quota) / (1024 * 1024);
      this.logger.warn(
        `Quota exceeded for userId ${userId}: usedSpace=${usedMB.toFixed(1)}MB + fileSize=${Number(size) / (1024 * 1024)}MB > quota=${quotaMB.toFixed(1)}MB`,
      );
      throw new HttpException(
        `Storage quota exceeded. Used: ${usedMB.toFixed(1)}MB, Quota: ${quotaMB.toFixed(1)}MB`,
        HttpStatus.BAD_REQUEST,
      );
    }
  }

  /**
   * Upload file nhỏ (≤ MAX_CHUNK_SIZE)
   * userId lấy từ JWT (req.user.userId)
   * Kiểm tra quota trước upload, cập nhật usedSpace sau upload bằng transaction.
   */
  async uploadFile(file: Express.Multer.File, userId: string, folderId?: string) {
    // Check quota trước khi upload lên Telegram
    await this.checkQuota(userId, file.size);

    const filename = Buffer.from(file.originalname, 'latin1').toString('utf8');

    const dek = this.cryptoService.generateFileKey();
    const iv = this.cryptoService.generateIv();
    const encryptedKey = this.cryptoService.encryptKey(dek);

    // 1) Tạo placeholder FileRecord trước khi upload
    const record = await this.prisma.fileRecord.create({
      data: {
        filename,
        size: file.size,
        mimeType: file.mimetype,
        telegramFileId: null,
        telegramMessageId: null,
        isChunked: false,
        totalChunks: 1,
        status: 'uploading',
        isEncrypted: true,
        encryptionAlgo: 'aes-256-ctr',
        encryptionIv: iv.toString('hex'),
        encryptedKey: encryptedKey,
        folderId: folderId || null,
        userId,
      },
    });

    this.logger.log(`Starting upload to Telegram for file: "${filename}" (${file.size} bytes)`);

    try {
      // 2) Encrypt and Upload lên Telegram
      const cipher = this.cryptoService.createEncryptStream(dek, iv);
      const encryptedBuffer = Buffer.concat([cipher.update(file.buffer), cipher.final()]);
      // Use record.id as the Telegram filename to avoid leaking the real filename
      const { fileId: telegramFileId, messageId: telegramMessageId, botIndex } = await this.telegram.uploadFile(encryptedBuffer, record.id);

      // 3) Thành công -> Update trạng thái và cộng dung lượng
      const updated = await this.prisma.$transaction(async (tx) => {
        const fileRecord = await tx.fileRecord.update({
          where: { id: record.id },
          data: {
            telegramFileId,
            telegramMessageId,
            botIndex,
            status: 'complete',
          },
        });

        await tx.user.update({
          where: { id: userId },
          data: { usedSpace: { increment: file.size } },
        });

        return fileRecord;
      });

      this.logger.log(`File uploaded: "${filename}" (${file.size} bytes, userId: ${userId}, recordId: ${record.id})`);
      return updated;
    } catch (err: unknown) {
      // Nếu lỗi upload, xoá placeholder record
      await this.prisma.fileRecord.delete({ where: { id: record.id } });
      this.logger.error(`Failed to upload file to Telegram: ${filename}`, err);
      throw err;
    }
  }

  /**
   * Khởi tạo upload chunked — tạo FileRecord placeholder với status "uploading"
   * userId lấy từ JWT (req.user.userId)
   * Kiểm tra quota trước khi init.
   */
  async initChunkedUpload(
    filename: string,
    size: number,
    mimeType: string,
    totalChunks: number,
    userId: string,
    folderId?: string,
  ) {
    // Check quota trước khi bắt đầu upload chunks
    await this.checkQuota(userId, size);
    const dek = this.cryptoService.generateFileKey();
    const iv = this.cryptoService.generateIv();
    const encryptedKey = this.cryptoService.encryptKey(dek);

    const record = await this.prisma.fileRecord.create({
      data: {
        filename,
        size,
        mimeType,
        telegramFileId: null,
        telegramMessageId: null,
        isChunked: true,
        totalChunks,
        status: 'uploading',
        isEncrypted: true,
        encryptionAlgo: 'aes-256-ctr',
        encryptionIv: iv.toString('hex'),
        encryptedKey: encryptedKey,
        folderId: folderId || null,
        userId,
      },
    });

    this.logger.log(`Chunked upload initialized: "${filename}" (${size} bytes, ${totalChunks} chunks, userId: ${userId}, recordId: ${record.id})`);
    return record;
  }

  /**
   * Upload chunk bằng stream pipe-through:
   * 
   *   Client ──stream──▶ busboy ──pipe──▶ ByteCounter ──pipe──▶ Telegram
   *                (tất cả diễn ra đồng thời, không buffer toàn bộ chunk)
   */
  async uploadChunkStream(fileId: string, chunkIndex: number, userId: string, req: any): Promise<any> {
    // Kiểm tra concurrent chunk upload limit
    const maxConcurrent = await this.getMaxConcurrentChunks();
    const active = this.activeUploads.get(userId) || 0;
    if (active >= maxConcurrent) {
      const waitMs = this.telegram.getWaitTimeMs();
      const retryAfter = Math.max(3, Math.ceil(waitMs / 1000));
      throw new HttpException(
        {
          message: `Too many concurrent uploads. Maximum ${maxConcurrent} chunks at a time.`,
          retryAfter,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    this.activeUploads.set(userId, active + 1);

    // AbortController để huỷ acquireUploadSlot khi client disconnect
    const abortController = new AbortController();
    let settled = false;

    // Lắng nghe socket close (TCP connection thực sự đóng) thay vì req close
    // (req 'close' fires khi body đã nhận xong, quá sớm)
    const socket = req.socket;
    const onSocketClose = () => {
      if (!settled) {
        this.logger.debug(`Client disconnected during chunk upload (file: ${fileId}, chunk: ${chunkIndex})`);
        abortController.abort();
      }
    };
    socket?.on('close', onSocketClose);

    try {
      return await this._uploadChunkStreamInternal(fileId, chunkIndex, userId, req, abortController.signal);
    } finally {
      settled = true;
      socket?.removeListener('close', onSocketClose);
      const current = this.activeUploads.get(userId) || 1;
      if (current <= 1) this.activeUploads.delete(userId);
      else this.activeUploads.set(userId, current - 1);
    }
  }

  private async _uploadChunkStreamInternal(fileId: string, chunkIndex: number, userId: string, req: any, signal?: AbortSignal): Promise<any> {
    const fileRecord = await this.prisma.fileRecord.findFirst({
      where: { id: fileId, userId, deletedAt: null },
    });
    if (!fileRecord) throw new NotFoundException('File record not found');
    if (fileRecord.status !== 'uploading') throw new BadRequestException('File upload already completed or aborted');
    if (chunkIndex < 0 || chunkIndex >= fileRecord.totalChunks) {
      throw new BadRequestException(`Invalid chunk index: ${chunkIndex}. Expected 0-${fileRecord.totalChunks - 1}`);
    }

    // Idempotent: nếu chunk đã upload THÀNH CÔNG rồi, bỏ qua
    const existing = await this.prisma.fileChunk.findUnique({
      where: { fileId_chunkIndex: { fileId, chunkIndex } },
    });
    if (existing) {
      if (existing.telegramFileId && existing.telegramFileId !== '') {
        // Chunk already uploaded successfully — skip
        req.resume();
        this.logger.debug(`Chunk ${chunkIndex}/${fileRecord.totalChunks} already uploaded for file ${fileId}, skipping`);
        return existing;
      }
      // Pending record from a failed attempt — delete it and retry
      await this.prisma.fileChunk.delete({ where: { id: existing.id } });
      this.logger.debug(`Deleted stale pending chunk ${chunkIndex} for file ${fileId}, retrying`);
    }

    // Use record id as chunk filename to avoid leaking the real filename on Telegram
    const chunkFilename = `${fileRecord.id}.part${String(chunkIndex).padStart(3, '0')}`;

    // Get DEK and generate new IV for this chunk
    let dek: Buffer | null = null;
    let chunkIv: Buffer | null = null;
    if (fileRecord.isEncrypted && fileRecord.encryptedKey) {
      dek = this.cryptoService.decryptKey(fileRecord.encryptedKey);
      chunkIv = this.cryptoService.generateIv();
    }

    return new Promise<any>((resolve, reject) => {
      const bb = Busboy({ headers: req.headers });
      let fileProcessed = false;

      bb.on('file', (_name: string, stream: Readable) => {
        if (fileProcessed) {
          stream.resume();
          return;
        }
        fileProcessed = true;

        // Collect the stream into a buffer so we can retry on ECONNRESET.
        // Chunks are typically ~20MB — safe to buffer in memory.
        const chunks: Buffer[] = [];
        let rawBytes = 0;

        let dataStream: Readable | Transform = stream;
        if (dek && chunkIv) {
          const cipherStream = this.cryptoService.createEncryptStream(dek, chunkIv);
          dataStream = stream.pipe(cipherStream);
        }

        dataStream.on('data', (buf: Buffer) => {
          chunks.push(buf);
          rawBytes += buf.length;
          if (rawBytes > MAX_CHUNK_SIZE) {
            stream.destroy();
            reject(new BadRequestException(
              `Chunk size exceeds maximum allowed size (${MAX_CHUNK_SIZE} bytes)`,
            ));
          }
        });

        dataStream.on('error', (err: Error) => reject(err));

        dataStream.on('end', () => {
          const buffer = Buffer.concat(chunks);

          // Check abort trước khi upload lên Telegram
          if (signal?.aborted) {
            reject(new Error('Upload cancelled'));
            return;
          }

          this.logger.log(`Starting chunk upload to Telegram: ${chunkIndex + 1}/${fileRecord.totalChunks} for file "${fileRecord.filename}" (${fileRecord.id}), ${rawBytes} bytes`);

          // Create pending DB record BEFORE uploading to Telegram
          this.prisma.fileChunk.create({
            data: {
              fileId,
              chunkIndex,
              size: rawBytes,
              telegramFileId: '', // placeholder — will be updated after upload
              telegramMessageId: null,
              ...(chunkIv && { encryptionIv: chunkIv.toString('hex') }),
            },
          })
            .then((pendingChunk) => {
              return this.telegram.uploadFile(buffer, chunkFilename, signal)
                .then(async ({ fileId: telegramFileId, messageId: telegramMessageId, botIndex }) => {
                  try {
                    // Update with real Telegram IDs
                    const updated = await this.prisma.fileChunk.update({
                      where: { id: pendingChunk.id },
                      data: { telegramFileId, telegramMessageId, botIndex },
                    });

                    // Check if file was aborted while we were uploading
                    const currentFile = await this.prisma.fileRecord.findUnique({
                      where: { id: fileId },
                      select: { status: true },
                    });
                    if (!currentFile || currentFile.status === 'aborted') {
                      this.logger.warn(`Chunk ${chunkIndex} for file ${fileId} completed but file was aborted — deleting Telegram message ${telegramMessageId}`);
                      this.telegram.deleteMessage(telegramMessageId).catch(() => {});
                      reject(new Error('Upload aborted'));
                      return;
                    }

                    this.logger.debug(`Chunk uploaded: ${chunkIndex + 1}/${fileRecord.totalChunks} for file ${fileId} (${rawBytes} bytes)`);
                    resolve(updated);
                  } catch (updateErr: any) {
                    // Race A: Record was cascade-deleted by abort — clean up the orphaned Telegram message
                    if (updateErr?.code === 'P2025') {
                      this.logger.warn(`Chunk ${chunkIndex} for file ${fileId} was aborted during upload — deleting orphaned Telegram message ${telegramMessageId}`);
                      this.telegram.deleteMessage(telegramMessageId).catch(() => {});
                      reject(new Error('Upload aborted'));
                      return;
                    }
                    reject(updateErr);
                  }
                });
            })
            .catch((err) => {
              // Clean up pending record if upload fails
              this.prisma.fileChunk.deleteMany({
                where: { fileId, chunkIndex },
              }).catch(() => {});
              this.logger.error(`Chunk upload failed: ${chunkIndex}/${fileRecord.totalChunks} for file ${fileId}: ${err.message}`);
              reject(err);
            });
        });
      });

      bb.on('error', (err: Error) => reject(err));

      bb.on('close', () => {
        if (!fileProcessed) {
          reject(new BadRequestException('No file field received in the request'));
        }
      });

      req.pipe(bb);
    });
  }

  /**
   * Huỷ upload chunked
   */
  async abortUpload(fileId: string, userId: string) {
    const fileRecord = await this.prisma.fileRecord.findFirst({
      where: { id: fileId, userId, deletedAt: null },
      include: { chunks: true },
    });
    if (!fileRecord) throw new NotFoundException('File record not found');

    if (fileRecord.status === 'complete') {
      throw new BadRequestException('Cannot abort a completed upload. Use DELETE instead.');
    }

    await this.prisma.fileRecord.update({
      where: { id: fileId },
      data: { status: 'aborted' },
    });

    // First pass: delete Telegram messages from initial snapshot
    const deletePromises = fileRecord.chunks.map(async (chunk) => {
      if (chunk.telegramMessageId) {
        await this.telegram.deleteMessage(chunk.telegramMessageId);
      }
    });
    await Promise.allSettled(deletePromises);

    // Re-query chunks to catch any in-flight uploads that completed during abort
    const latestChunks = await this.prisma.fileChunk.findMany({
      where: { fileId },
    });
    const alreadyDeleted = new Set(
      fileRecord.chunks.filter(c => c.telegramMessageId).map(c => c.telegramMessageId),
    );
    for (const chunk of latestChunks) {
      if (chunk.telegramMessageId && !alreadyDeleted.has(chunk.telegramMessageId)) {
        await this.telegram.deleteMessage(chunk.telegramMessageId);
      }
    }

    await this.prisma.fileRecord.delete({ where: { id: fileId } });

    this.logger.warn(`Upload aborted: "${fileRecord.filename}" (fileId: ${fileId}, cleaned up ${latestChunks.length} chunks)`);
    return { success: true, deletedChunks: latestChunks.length };
  }

  /**
   * Hoàn tất upload chunked — kiểm tra đủ chunks rồi đánh dấu complete.
   * Cập nhật usedSpace trong transaction.
   */
  async completeChunkedUpload(fileId: string, userId: string) {
    const fileRecord = await this.prisma.fileRecord.findFirst({
      where: { id: fileId, userId, deletedAt: null },
      include: { chunks: true },
    });
    if (!fileRecord) throw new NotFoundException('File record not found');
    if (fileRecord.status === 'complete') return fileRecord;

    const uploadedChunks = fileRecord.chunks.length;
    if (uploadedChunks < fileRecord.totalChunks) {
      throw new BadRequestException(
        `Missing chunks: uploaded ${uploadedChunks}/${fileRecord.totalChunks}`,
      );
    }

    // Transaction: đánh dấu complete + cộng usedSpace
    const result = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.fileRecord.update({
        where: { id: fileId },
        data: { status: 'complete' },
      });

      await tx.user.update({
        where: { id: userId },
        data: { usedSpace: { increment: fileRecord.size } },
      });

      return updated;
    });

    this.logger.log(`Chunked upload completed: "${fileRecord.filename}" (fileId: ${fileId}, ${fileRecord.totalChunks} chunks, ${fileRecord.size} bytes)`);
    return result;
  }

  /**
   * Truy vấn metadata file cụ thể
   */
  async getFileInfo(id: string, userId: string) {
    const fileRecord = await this.prisma.fileRecord.findFirst({
      where: { id, userId, deletedAt: null },
      select: {
        id: true,
        filename: true,
        size: true,
        mimeType: true,
        createdAt: true,
      },
    });
    if (!fileRecord) throw new NotFoundException('File not found');
    return fileRecord;
  }

  /**
   * Lấy thông tin download — hỗ trợ cả file thường và file chunked
   * Scope theo userId để đảm bảo user chỉ download file của mình
   */
  async getDownloadInfo(id: string, userId: string) {
    const fileRecord = await this.prisma.fileRecord.findFirst({
      where: { id, userId, deletedAt: null },
      include: { chunks: { orderBy: { chunkIndex: 'asc' } } },
    });
    if (!fileRecord) throw new NotFoundException('File not found');
    if (fileRecord.status !== 'complete') throw new BadRequestException('File upload not completed yet');

    return this.getDownloadMetadata(fileRecord);
  }

  /**
   * Lấy thông tin download bằng share token (dùng cho public)
   */
  async getDownloadInfoByToken(token: string) {
    const fileRecord = await this.prisma.fileRecord.findUnique({
      where: { shareToken: token },
      include: { chunks: { orderBy: { chunkIndex: 'asc' } } },
    });
    if (!fileRecord || fileRecord.deletedAt) throw new NotFoundException('Shared file not found');
    if (fileRecord.status !== 'complete') throw new BadRequestException('File upload not completed yet');

    return this.getDownloadMetadata(fileRecord);
  }

  /**
   * Helper trích xuất metadata download từ FileRecord (không resolve URL — URL được resolve lazily khi stream)
   */
  getDownloadMetadata(fileRecord: {
    filename: string;
    size: bigint | number;
    telegramFileId: string | null;
    botIndex: number;
    telegramMessageId: number | null;
    isChunked: boolean;
    isEncrypted: boolean;
    encryptedKey: string | null;
    encryptionIv: string | null;
    mimeType: string;
    chunks: Array<{
      id: string;
      telegramFileId: string;
      botIndex: number;
      telegramMessageId: number | null;
      encryptionIv: string | null;
      size: number | bigint;
    }>;
  }): DownloadInfo {
    let dek: Buffer | null = null;
    if (fileRecord.isEncrypted && fileRecord.encryptedKey) {
      dek = this.cryptoService.decryptKey(fileRecord.encryptedKey);
    }

    if (!fileRecord.isChunked && fileRecord.telegramFileId) {
      return {
        filename: fileRecord.filename,
        size: fileRecord.size,
        telegramFileId: fileRecord.telegramFileId,
        botIndex: fileRecord.botIndex ?? 0,
        telegramMessageId: fileRecord.telegramMessageId,
        isEncrypted: fileRecord.isEncrypted,
        dek,
        iv: fileRecord.encryptionIv ? Buffer.from(fileRecord.encryptionIv, 'hex') : null,
        mimeType: fileRecord.mimeType,
      };
    }

    const chunks = fileRecord.chunks.map((chunk) => ({
      id: chunk.id,
      telegramFileId: chunk.telegramFileId,
      botIndex: chunk.botIndex ?? 0,
      telegramMessageId: chunk.telegramMessageId,
      iv: chunk.encryptionIv ? Buffer.from(chunk.encryptionIv, 'hex') : null,
      size: Number(chunk.size),
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

  /** Number of chunks to prefetch URLs ahead of the current streaming position */
  private readonly PREFETCH_AHEAD = 2;

  /**
   * Resolve file link with auto-recovery: if the bot that uploaded the file is no longer
   * available, forward the original message via main bot to get a new file_id.
   */
  private async resolveFileLink(
    telegramFileId: string,
    botIndex: number,
    telegramMessageId: number | null,
    chunkDbId: string | null,
    context?: string,
  ): Promise<string> {
    if (botIndex < this.telegram.botCount) {
      return this.telegram.getFileLink(telegramFileId, botIndex, context);
    }
    // Bot unavailable → recover via forwardMessage
    if (!telegramMessageId) {
      throw new Error(`Bot ${botIndex} unavailable and no messageId for recovery`);
    }
    this.logger.warn(`Bot ${botIndex} unavailable, recovering via forward (messageId: ${telegramMessageId})`);
    const { fileId: newFileId, botIndex: newBotIndex } = await this.telegram.recoverFileId(telegramMessageId);
    // Cập nhật DB (fire-and-forget, không block download)
    if (chunkDbId) {
      this.prisma.fileChunk.update({
        where: { id: chunkDbId },
        data: { telegramFileId: newFileId, botIndex: newBotIndex },
      }).catch(e => this.logger.warn(`Failed to update recovered chunk: ${e.message}`));
    }
    return this.telegram.getFileLink(newFileId, newBotIndex, context);
  }

  /**
   * Admin: re-index all chunks/files whose bot is no longer available.
   */
  async reindexUnavailableBots(): Promise<{ recovered: number; failed: number }> {
    const botCount = this.telegram.botCount;
    const staleChunks = await this.prisma.fileChunk.findMany({
      where: { botIndex: { gte: botCount } },
    });
    const staleFiles = await this.prisma.fileRecord.findMany({
      where: { botIndex: { gte: botCount }, isChunked: false, telegramMessageId: { not: null } },
    });

    let recovered = 0;
    let failed = 0;

    for (const chunk of staleChunks) {
      try {
        if (!chunk.telegramMessageId) { failed++; continue; }
        const { fileId, botIndex } = await this.telegram.recoverFileId(chunk.telegramMessageId);
        await this.prisma.fileChunk.update({
          where: { id: chunk.id },
          data: { telegramFileId: fileId, botIndex },
        });
        recovered++;
      } catch {
        failed++;
      }
    }

    for (const file of staleFiles) {
      try {
        if (!file.telegramMessageId) { failed++; continue; }
        const { fileId, botIndex } = await this.telegram.recoverFileId(file.telegramMessageId);
        await this.prisma.fileRecord.update({
          where: { id: file.id },
          data: { telegramFileId: fileId, botIndex },
        });
        recovered++;
      } catch {
        failed++;
      }
    }

    this.logger.log(`Reindex complete: ${recovered} recovered, ${failed} failed`);
    return { recovered, failed };
  }

  /**
   * Helper: pipe Telegram fetch stream → optional decrypt → res, with proper error handling.
   * Prevents unhandled 'error' events on Readable.fromWeb() from crashing the process.
   */
  private pipeStreamToResponse(
    fetchBody: ReadableStream,
    res: Response,
    options: {
      decrypt?: { dek: Buffer; iv: Buffer; offset?: number };
      endResponse?: boolean;
    } = {},
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const rawStream = Readable.fromWeb(fetchBody as any);

      // CRITICAL: always attach error handler on the raw stream
      rawStream.on('error', (err) => {
        if (!res.destroyed) res.end();
        reject(err);
      });

      let output: Readable | Transform = rawStream;

      if (options.decrypt) {
        const decryptStream = options.decrypt.offset !== undefined
          ? this.cryptoService.createOffsetDecryptStream(options.decrypt.dek, options.decrypt.iv, options.decrypt.offset)
          : this.cryptoService.createDecryptStream(options.decrypt.dek, options.decrypt.iv);
        decryptStream.on('error', (err) => {
          rawStream.destroy();
          if (!res.destroyed) res.end();
          reject(err);
        });
        output = rawStream.pipe(decryptStream);
      }

      output.on('end', resolve);
      // For non-encrypted, this duplicates rawStream's handler — safe because reject() is idempotent for promises
      output.on('error', reject);

      // Detect client disconnect → cleanup Telegram fetch stream
      const onResClose = () => {
        if (!res.writableFinished) {
          rawStream.destroy();
        }
      };
      res.on('close', onResClose);

      output.pipe(res, { end: options.endResponse ?? false });

      // Cleanup: remove close listener when pipe finishes to avoid accumulation on chunked downloads
      const cleanup = () => res.removeListener('close', onResClose);
      output.on('end', cleanup);
      output.on('error', cleanup);
    });
  }

  private isClientDisconnect(err: unknown): boolean {
    if (err instanceof Error) {
      const code = (err as NodeJS.ErrnoException).code;
      return code === 'ECONNRESET' || err.message === 'terminated' || code === 'ERR_STREAM_PREMATURE_CLOSE';
    }
    return false;
  }

  /**
   * Helper process download file (dùng Streams)
   * Resolve URLs lazily: stream chunk[i] trong khi prefetch URL cho chunk[i+1..i+PREFETCH_AHEAD]
   */
  async processDownload(downloadInfo: DownloadInfo, res: Response, rangeHeader?: string) {
    // Multi-thread download: nếu có Range header và tính năng được bật → delegate sang processRangeDownload
    if (rangeHeader && await this.isMultiThreadEnabled()) {
      return this.processRangeDownload(downloadInfo, rangeHeader, res);
    }

    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(downloadInfo.filename)}"`);
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Length', downloadInfo.size.toString());

    // Thêm Accept-Ranges nếu multi-thread download được bật
    if (await this.isMultiThreadEnabled()) {
      res.setHeader('Accept-Ranges', 'bytes');
    }

    if (!downloadInfo.isChunked) {
      const url = await this.resolveFileLink(
        downloadInfo.telegramFileId, downloadInfo.botIndex ?? 0,
        downloadInfo.telegramMessageId, null,
      );
      const fetchRes = await fetchWithRetry(url);
      if (!fetchRes.ok || !fetchRes.body) {
        this.logger.error(`Failed to fetch file from Telegram: "${downloadInfo.filename}" (status: ${fetchRes.status}, url: ${url})`);
        res.status(500).send('Trích xuất file từ Telegram thất bại');
        return;
      }

      try {
        await this.pipeStreamToResponse(fetchRes.body, res, {
          decrypt: (downloadInfo.isEncrypted && downloadInfo.dek && downloadInfo.iv)
            ? { dek: downloadInfo.dek, iv: downloadInfo.iv }
            : undefined,
          endResponse: true,
        });
      } catch (err: unknown) {
        if (this.isClientDisconnect(err)) {
          this.logger.debug(`Client disconnected during download: "${downloadInfo.filename}"`);
        } else {
          this.logger.error(`Download failed: "${downloadInfo.filename}"`, err instanceof Error ? err.message : String(err));
          if (!res.headersSent) res.status(500).end();
          else if (!res.destroyed) res.end();
        }
      }
    } else {
      try {
        const chunks = downloadInfo.chunks;
        const totalChunks = chunks.length;

        for (let i = 0; i < totalChunks; i++) {
          // Prefetch URLs cho các chunk tiếp theo (fire-and-forget, chúng sẽ được cache)
          for (let p = i + 1; p < Math.min(i + 1 + this.PREFETCH_AHEAD, totalChunks); p++) {
            this.resolveFileLink(
              chunks[p].telegramFileId, chunks[p].botIndex ?? 0,
              chunks[p].telegramMessageId, chunks[p].id,
              `prefetch chunk ${p + 1}/${totalChunks} of "${downloadInfo.filename}"`,
            );
          }

          // Resolve URL cho chunk hiện tại (instant nếu đã prefetch/cache)
          const url = await this.resolveFileLink(
            chunks[i].telegramFileId, chunks[i].botIndex ?? 0,
            chunks[i].telegramMessageId, chunks[i].id,
            `chunk ${i + 1}/${totalChunks} of "${downloadInfo.filename}"`,
          );

          const fetchRes = await fetchWithRetry(url);
          if (!fetchRes.ok || !fetchRes.body) {
            throw new Error(`Failed to fetch chunk ${i + 1}/${totalChunks} from Telegram`);
          }

          await this.pipeStreamToResponse(fetchRes.body!, res, {
            decrypt: (downloadInfo.isEncrypted && downloadInfo.dek && chunks[i].iv)
              ? { dek: downloadInfo.dek, iv: chunks[i].iv! }
              : undefined,
          });
        }
        res.end();
      } catch (error: unknown) {
        if (this.isClientDisconnect(error)) {
          this.logger.debug(`Client disconnected during chunked download: "${downloadInfo.filename}"`);
        } else {
          this.logger.error(`Chunked download failed: "${downloadInfo.filename}"`, error instanceof Error ? error.stack : String(error));
          if (!res.headersSent) {
            res.status(500).send('Lỗi khi ghép file từ Telegram');
          } else if (!res.destroyed) {
            res.end();
          }
        }
      }
    }
  }

  /**
   * Helper process streaming media (dùng Range Requests)
   * Resolve chunk URLs lazily — chỉ resolve cho các chunks overlap với Range
   */
  async processStream(downloadInfo: DownloadInfo, rangeHeader: string | undefined, res: Response) {
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
    res.setHeader('Content-Type', downloadInfo.mimeType || 'application/octet-stream');
    res.setHeader('Content-Disposition', 'inline');

    if (!downloadInfo.isChunked) {
      const url = await this.resolveFileLink(
        downloadInfo.telegramFileId, downloadInfo.botIndex ?? 0,
        downloadInfo.telegramMessageId, null,
      );
      const fetchRes = await fetchWithRetry(url, {
        headers: { Range: `bytes=${start}-${end}` }
      });
      if (!fetchRes.ok || !fetchRes.body) {
        this.logger.error(`Failed to fetch stream from Telegram: "${downloadInfo.filename}"`);
        return res.status(500).end();
      }

      try {
        await this.pipeStreamToResponse(fetchRes.body, res, {
          decrypt: (downloadInfo.isEncrypted && downloadInfo.dek && downloadInfo.iv)
            ? { dek: downloadInfo.dek, iv: downloadInfo.iv, offset: start }
            : undefined,
          endResponse: true,
        });
      } catch (err: unknown) {
        if (this.isClientDisconnect(err)) {
          this.logger.debug(`Client disconnected during stream: "${downloadInfo.filename}"`);
        } else {
          this.logger.error(`Stream failed: "${downloadInfo.filename}"`, err instanceof Error ? err.message : String(err));
          if (!res.headersSent) res.status(500).end();
          else if (!res.destroyed) res.end();
        }
      }
    } else {
      let currentOffset = 0;
      const chunksToFetch: { telegramFileId: string; botIndex: number; telegramMessageId: number | null; id: string | null; iv: Buffer | null; size: number; fetchStart: number; fetchEnd: number; byteOffsetInChunk: number }[] = [];

      for (const chunk of downloadInfo.chunks) {
        const chunkStart = currentOffset;
        const chunkEnd = currentOffset + chunk.size - 1;

        if (start <= chunkEnd && end >= chunkStart) {
          const fetchStart = Math.max(start, chunkStart) - chunkStart;
          const fetchEnd = Math.min(end, chunkEnd) - chunkStart;

          chunksToFetch.push({
            telegramFileId: chunk.telegramFileId,
            botIndex: chunk.botIndex ?? 0,
            telegramMessageId: chunk.telegramMessageId,
            id: chunk.id,
            iv: chunk.iv,
            size: chunk.size,
            fetchStart,
            fetchEnd,
            byteOffsetInChunk: fetchStart,
          });
        }
        currentOffset += chunk.size;
      }

      try {
        for (let i = 0; i < chunksToFetch.length; i++) {
          const chunkReq = chunksToFetch[i];

          // Prefetch URLs cho các chunk tiếp theo
          for (let p = i + 1; p < Math.min(i + 1 + this.PREFETCH_AHEAD, chunksToFetch.length); p++) {
            this.resolveFileLink(
              chunksToFetch[p].telegramFileId, chunksToFetch[p].botIndex ?? 0,
              chunksToFetch[p].telegramMessageId, chunksToFetch[p].id,
            );
          }

          const url = await this.resolveFileLink(
            chunkReq.telegramFileId, chunkReq.botIndex ?? 0,
            chunkReq.telegramMessageId, chunkReq.id,
          );
          const fetchRes = await fetchWithRetry(url, {
            headers: { Range: `bytes=${chunkReq.fetchStart}-${chunkReq.fetchEnd}` }
          });
          if (!fetchRes.ok || !fetchRes.body) throw new Error('Fetch chunk error');

          await this.pipeStreamToResponse(fetchRes.body, res, {
            decrypt: (downloadInfo.isEncrypted && downloadInfo.dek && chunkReq.iv)
              ? { dek: downloadInfo.dek, iv: chunkReq.iv, offset: chunkReq.byteOffsetInChunk }
              : undefined,
          });
        }
        res.end();
      } catch (err: unknown) {
        if (this.isClientDisconnect(err)) {
          this.logger.debug(`Client disconnected during stream: "${downloadInfo.filename}"`);
        } else {
          this.logger.error('Stream error', err);
        }
        if (!res.headersSent) res.status(500).end();
        else if (!res.destroyed) res.end();
      }
    }
  }

  /**
   * Download với Range header (cho multi-thread download managers như IDM)
   * Giống processStream nhưng giữ Content-Disposition: attachment
   */
  private async processRangeDownload(downloadInfo: DownloadInfo, rangeHeader: string, res: Response) {
    const fileSize = Number(downloadInfo.size);
    let start = 0;
    let end = fileSize - 1;

    const match = rangeHeader.match(/bytes=(\d+)-(\d*)/);
    if (match) {
      start = parseInt(match[1], 10);
      if (match[2]) {
        end = parseInt(match[2], 10);
      }
    }

    if (start >= fileSize) {
      res.status(416).setHeader('Content-Range', `bytes */${fileSize}`);
      return res.end();
    }

    end = Math.min(end, fileSize - 1);
    const contentLength = end - start + 1;

    res.status(206);
    res.setHeader('Content-Range', `bytes ${start}-${end}/${fileSize}`);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Length', contentLength.toString());
    res.setHeader('Content-Type', downloadInfo.mimeType || 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(downloadInfo.filename)}"`);

    if (!downloadInfo.isChunked) {
      const url = await this.resolveFileLink(
        downloadInfo.telegramFileId, downloadInfo.botIndex ?? 0,
        downloadInfo.telegramMessageId, null,
      );
      const fetchRes = await fetchWithRetry(url, {
        headers: { Range: `bytes=${start}-${end}` },
      });
      if (!fetchRes.ok || !fetchRes.body) {
        this.logger.error(`Failed to fetch range from Telegram: "${downloadInfo.filename}"`);
        return res.status(500).end();
      }

      try {
        await this.pipeStreamToResponse(fetchRes.body, res, {
          decrypt: (downloadInfo.isEncrypted && downloadInfo.dek && downloadInfo.iv)
            ? { dek: downloadInfo.dek, iv: downloadInfo.iv, offset: start }
            : undefined,
          endResponse: true,
        });
      } catch (err: unknown) {
        if (this.isClientDisconnect(err)) {
          this.logger.debug(`Client disconnected during range download: "${downloadInfo.filename}"`);
        } else {
          this.logger.error(`Range download failed: "${downloadInfo.filename}"`, err instanceof Error ? err.message : String(err));
          if (!res.headersSent) res.status(500).end();
          else if (!res.destroyed) res.end();
        }
      }
    } else {
      let currentOffset = 0;
      const chunksToFetch: { telegramFileId: string; botIndex: number; telegramMessageId: number | null; id: string | null; iv: Buffer | null; size: number; fetchStart: number; fetchEnd: number; byteOffsetInChunk: number }[] = [];

      for (const chunk of downloadInfo.chunks) {
        const chunkStart = currentOffset;
        const chunkEnd = currentOffset + chunk.size - 1;

        if (start <= chunkEnd && end >= chunkStart) {
          const fetchStart = Math.max(start, chunkStart) - chunkStart;
          const fetchEnd = Math.min(end, chunkEnd) - chunkStart;

          chunksToFetch.push({
            telegramFileId: chunk.telegramFileId,
            botIndex: chunk.botIndex ?? 0,
            telegramMessageId: chunk.telegramMessageId,
            id: chunk.id,
            iv: chunk.iv,
            size: chunk.size,
            fetchStart,
            fetchEnd,
            byteOffsetInChunk: fetchStart,
          });
        }
        currentOffset += chunk.size;
      }

      try {
        for (let i = 0; i < chunksToFetch.length; i++) {
          const chunkReq = chunksToFetch[i];

          for (let p = i + 1; p < Math.min(i + 1 + this.PREFETCH_AHEAD, chunksToFetch.length); p++) {
            this.resolveFileLink(
              chunksToFetch[p].telegramFileId, chunksToFetch[p].botIndex ?? 0,
              chunksToFetch[p].telegramMessageId, chunksToFetch[p].id,
            );
          }

          const url = await this.resolveFileLink(
            chunkReq.telegramFileId, chunkReq.botIndex ?? 0,
            chunkReq.telegramMessageId, chunkReq.id,
          );
          const fetchRes = await fetchWithRetry(url, {
            headers: { Range: `bytes=${chunkReq.fetchStart}-${chunkReq.fetchEnd}` },
          });
          if (!fetchRes.ok || !fetchRes.body) throw new Error('Fetch chunk error');

          await this.pipeStreamToResponse(fetchRes.body, res, {
            decrypt: downloadInfo.isEncrypted && downloadInfo.dek && chunkReq.iv
              ? { dek: downloadInfo.dek, iv: chunkReq.iv, offset: chunkReq.byteOffsetInChunk }
              : undefined,
          });
        }
        res.end();
      } catch (err: unknown) {
        if (this.isClientDisconnect(err)) {
          this.logger.debug(`Client disconnected during range download: "${downloadInfo.filename}"`);
        } else {
          this.logger.error(`Range download error: "${downloadInfo.filename}"`, err instanceof Error ? err.message : String(err));
        }
        if (!res.headersSent) res.status(500).end();
        else if (!res.destroyed) res.end();
      }
    }
  }

  /**
   * Lấy thông tin file shared
   */
  async getSharedFileInfo(token: string) {
    const fileRecord = await this.prisma.fileRecord.findUnique({
      where: { shareToken: token },
      select: {
        id: true,
        filename: true,
        size: true,
        mimeType: true,
        createdAt: true,
        user: { select: { username: true } },
      },
    });
    if (!fileRecord) throw new NotFoundException('Shared file not found');

    return fileRecord;
  }

  /**
   * Đổi tên file
   */
  async rename(id: string, newName: string, userId: string) {
    const fileRecord = await this.prisma.fileRecord.findFirst({
      where: { id, userId, deletedAt: null },
    });
    if (!fileRecord) throw new NotFoundException('File not found');

    const updated = await this.prisma.fileRecord.update({
      where: { id },
      data: { filename: newName },
    });

    this.logger.log(`File renamed: "${fileRecord.filename}" to "${newName}" (fileId: ${id})`);
    return updated;
  }

  /**
   * Di chuyển file
   */
  async move(id: string, newFolderId: string | null, userId: string) {
    const fileRecord = await this.prisma.fileRecord.findFirst({
      where: { id, userId, deletedAt: null },
    });
    if (!fileRecord) throw new NotFoundException('File not found');

    if (newFolderId) {
      const folder = await this.prisma.folder.findFirst({
        where: { id: newFolderId, userId, deletedAt: null },
      });
      if (!folder) throw new NotFoundException('Destination folder not found');
    }

    const updated = await this.prisma.fileRecord.update({
      where: { id },
      data: { folderId: newFolderId },
    });

    this.logger.log(`File moved: "${fileRecord.filename}" (fileId: ${id}) to folder: ${newFolderId || 'root'}`);
    return updated;
  }

  /**
   * Chia sẻ file (tạo shareLink)
   */
  async share(id: string, userId: string) {
    const fileRecord = await this.prisma.fileRecord.findFirst({
      where: { id, userId, deletedAt: null },
    });
    if (!fileRecord) throw new NotFoundException('File not found');

    const shareToken = fileRecord.shareToken || crypto.randomBytes(16).toString('hex');

    const updated = await this.prisma.fileRecord.update({
      where: { id },
      data: { 
        visibility: 'PUBLIC_LINK',
        shareToken,
      },
    });

    this.logger.log(`File shared: "${fileRecord.filename}" (fileId: ${id}, token: ${shareToken})`);
    return updated;
  }

  /**
   * Huỷ chia sẻ file
   */
  async unshare(id: string, userId: string) {
    const fileRecord = await this.prisma.fileRecord.findFirst({
      where: { id, userId, deletedAt: null },
    });
    if (!fileRecord) throw new NotFoundException('File not found');

    const updated = await this.prisma.fileRecord.update({
      where: { id },
      data: { 
        visibility: 'PRIVATE',
        shareToken: null,
      },
    });

    this.logger.log(`File unshared: "${fileRecord.filename}" (fileId: ${id})`);
    return updated;
  }

  /**
   * Xoá vĩnh viễn file — xoá trên Telegram + DB + hoàn trả usedSpace.
   * Scope theo userId nếu có.
   */
  async delete(id: string, userId?: string) {
    const where: any = { id };
    if (userId) {
      where.userId = userId;
      where.deletedAt = null;
    }

    const fileRecord = await this.prisma.fileRecord.findFirst({
      where,
      include: { chunks: true },
    });
    if (!fileRecord) return;

    if (fileRecord.telegramMessageId) {
      await this.telegram.deleteMessage(fileRecord.telegramMessageId);
    }

    for (const chunk of fileRecord.chunks) {
      if (chunk.telegramMessageId) {
        await this.telegram.deleteMessage(chunk.telegramMessageId);
      }
    }

    // Transaction: xoá FileRecord + trừ usedSpace (chỉ nếu file đã complete)
    await this.prisma.$transaction(async (tx) => {
      await tx.fileRecord.delete({ where: { id } });

      if (fileRecord.status === 'complete') {
        await tx.user.update({
          where: { id: fileRecord.userId },
          data: { usedSpace: { decrement: fileRecord.size } },
        });
      }
    });

    this.logger.log(`File deleted: "${fileRecord.filename}" (fileId: ${id}, chunks: ${fileRecord.chunks.length}, freed: ${fileRecord.size} bytes)`);
  }

  /**
   * Soft delete — chuyển file vào thùng rác (giữ nguyên usedSpace).
   */
  async softDelete(id: string, userId: string) {
    const fileRecord = await this.prisma.fileRecord.findFirst({
      where: { id, userId, deletedAt: null },
    });
    if (!fileRecord) throw new NotFoundException('File not found');

    const updated = await this.prisma.fileRecord.update({
      where: { id },
      data: { deletedAt: new Date() },
    });

    this.logger.log(`File soft-deleted: "${fileRecord.filename}" (fileId: ${id}, userId: ${userId})`);
    return updated;
  }

  /**
   * Khôi phục file từ thùng rác.
   */
  async restore(id: string, userId: string) {
    const fileRecord = await this.prisma.fileRecord.findFirst({
      where: { id, userId, deletedAt: { not: null } },
    });
    if (!fileRecord) throw new NotFoundException('File not found in trash');

    const updated = await this.prisma.fileRecord.update({
      where: { id },
      data: { deletedAt: null },
    });

    this.logger.log(`File restored: "${fileRecord.filename}" (fileId: ${id}, userId: ${userId})`);
    return updated;
  }

  /**
   * Xoá vĩnh viễn file từ thùng rác — xoá trên Telegram + DB + hoàn trả usedSpace.
   */
  async permanentDelete(id: string, userId: string) {
    const fileRecord = await this.prisma.fileRecord.findFirst({
      where: { id, userId, deletedAt: { not: null } },
      include: { chunks: true },
    });
    if (!fileRecord) throw new NotFoundException('File not found in trash');

    // Xoá trên Telegram
    if (fileRecord.telegramMessageId) {
      await this.telegram.deleteMessage(fileRecord.telegramMessageId);
    }
    for (const chunk of fileRecord.chunks) {
      if (chunk.telegramMessageId) {
        await this.telegram.deleteMessage(chunk.telegramMessageId);
      }
    }

    // Transaction: xoá DB + trừ usedSpace
    await this.prisma.$transaction(async (tx) => {
      await tx.fileRecord.delete({ where: { id } });

      if (fileRecord.status === 'complete') {
        await tx.user.update({
          where: { id: fileRecord.userId },
          data: { usedSpace: { decrement: fileRecord.size } },
        });
      }
    });

    this.logger.log(`File permanently deleted: "${fileRecord.filename}" (fileId: ${id}, freed: ${fileRecord.size} bytes)`);
  }

  /**
   * Danh sách file trong thùng rác của user.
   */
  async listTrash(userId: string) {
    return this.prisma.fileRecord.findMany({
      where: { userId, deletedAt: { not: null } },
      orderBy: { deletedAt: 'desc' },
    });
  }

  /**
   * Lấy danh sách chunks đã upload cho file (dùng cho resume upload)
   */
  async getUploadedChunks(fileId: string, userId: string) {
    const fileRecord = await this.prisma.fileRecord.findFirst({
      where: { id: fileId, userId, deletedAt: null },
    });
    if (!fileRecord) throw new NotFoundException('File record not found');

    const chunks = await this.prisma.fileChunk.findMany({
      where: { fileId },
      select: { chunkIndex: true },
      orderBy: { chunkIndex: 'asc' },
    });

    return {
      fileId,
      totalChunks: fileRecord.totalChunks,
      uploadedIndexes: chunks.map((c: { chunkIndex: number }) => c.chunkIndex),
      status: fileRecord.status,
    };
  }
}
