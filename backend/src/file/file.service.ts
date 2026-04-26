import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  HttpException,
  HttpStatus,
  UnauthorizedException,
  ConflictException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { TelegramService } from '../telegram/telegram.service';
import { fetchWithRetry } from '../telegram/telegram.service';
import { Transform, TransformCallback, Readable } from 'stream';
import Busboy from 'busboy';
import { PaginationQueryDto } from '../common/dto/pagination-query.dto';
import { PaginatedResponse } from '../common/types/paginated-response.type';
import * as crypto from 'crypto';
import type { Response } from 'express';
import { CryptoService } from '../crypto/crypto.service';
import { SettingsService } from '../settings/settings.service';
import { MAX_CHUNK_SIZE } from '../config/upload.config';
import type { DownloadInfo } from '../common/types/download';
import {
  NameConflictService,
  ConflictAction,
} from '../common/name-conflict.service';
import { message } from 'telegraf/filters';

/**
 * Transform stream đếm bytes đi qua — dùng để biết kích thước chunk
 * mà không cần buffer toàn bộ vào memory.
 */
class ByteCounter extends Transform {
  public bytes = 0;
  _transform(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: TransformCallback,
  ) {
    this.bytes += chunk.length;
    this.push(chunk);
    callback();
  }
}

@Injectable()
export class FileService {
  private readonly logger = new Logger(FileService.name);

  /** Track active chunk uploads per user for concurrency enforcement */
  private readonly activeUploads = new Map<string, number>();

  /** Lock map to prevent concurrent permanent deletions per user (preventing dual clicks) */
  private readonly deletionLocks = new Map<string, Promise<void>>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly telegram: TelegramService,
    private readonly cryptoService: CryptoService,
    private readonly settingsService: SettingsService,
    private readonly nameConflictService: NameConflictService,
  ) {}

  /**
   * Acquire a per-user lock to serialize concurrent deletions.
   */
  private async acquireDeletionLock(userId: string): Promise<() => void> {
    while (this.deletionLocks.has(userId)) {
      await this.deletionLocks.get(userId);
    }
    let releaseLock!: () => void;
    const lockPromise = new Promise<void>((resolve) => {
      releaseLock = () => {
        this.deletionLocks.delete(userId);
        resolve();
      };
    });
    this.deletionLocks.set(userId, lockPromise);
    return releaseLock;
  }

  /**
   * Kiểm tra setting ENABLE_MULTI_THREAD_DOWNLOAD (cached 30s via SettingsService)
   */
  async isMultiThreadEnabled(): Promise<boolean> {
    return this.settingsService.getCachedSetting(
      'ENABLE_MULTI_THREAD_DOWNLOAD',
      true,
      (v) => v !== 'false',
    );
  }

  /**
   * Kiểm tra setting MAX_CONCURRENT_CHUNKS (cached 30s via SettingsService)
   */
  async getMaxConcurrentChunks(): Promise<number> {
    return this.settingsService.getCachedSetting(
      'MAX_CONCURRENT_CHUNKS',
      3,
      (v) => parseInt(v, 10),
    );
  }

  /**
   * Lấy TTL cho signed download URL (cached 30s via SettingsService)
   */
  async getDownloadTtl(): Promise<number> {
    return this.settingsService.getCachedSetting(
      'DOWNLOAD_URL_TTL_SECONDS',
      300,
      (v) => parseInt(v, 10),
    );
  }

  /**
   * Lấy TTL cho stream cookie (cached 30s via SettingsService)
   */
  async getStreamTtl(): Promise<number> {
    return this.settingsService.getCachedSetting(
      'STREAM_COOKIE_TTL_SECONDS',
      3600,
      (v) => parseInt(v, 10),
    );
  }

  // ── Signed Download Token ──────────────────────────────────────────────

  /**
   * Tạo signed download URL cho user (auth required)
   */
  async generateDownloadToken(
    fileId: string,
    userId: string,
  ): Promise<{ url: string; expiresAt: string }> {
    const file = await this.prisma.fileRecord.findFirst({
      where: { id: fileId, userId, status: 'complete', deletedAt: null },
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

  /**
   * Tạo signed download URL cho shared file (public)
   */
  async generateShareDownloadToken(
    shareToken: string,
  ): Promise<{ url: string; expiresAt: string }> {
    const file = await this.prisma.fileRecord.findUnique({
      where: { shareToken },
      select: { id: true, status: true, deletedAt: true },
    });
    if (!file || file.deletedAt)
      throw new NotFoundException('Shared file not found');
    if (file.status !== 'complete')
      throw new BadRequestException('File upload not completed yet');

    const ttl = await this.getDownloadTtl();
    const token = this.cryptoService.createSignedToken(file.id, 's', ttl);
    const expiresAt = new Date(Date.now() + ttl * 1000).toISOString();

    this.logger.debug(
      `Share download token generated: shareToken=${shareToken}, fileId=${file.id}, ttl=${ttl}s`,
    );
    return { url: `/files/d/${token}`, expiresAt };
  }

  /**
   * Resolve signed download token → DownloadInfo
   */
  async downloadBySignedToken(signedToken: string): Promise<DownloadInfo> {
    const payload = this.cryptoService.verifySignedToken(signedToken);
    if (!payload)
      throw new UnauthorizedException('Invalid or expired download link');

    const fileRecord = await this.prisma.fileRecord.findFirst({
      where: { id: payload.fid, status: 'complete', deletedAt: null },
      include: { chunks: { orderBy: { chunkIndex: 'asc' } } },
    });
    if (!fileRecord) throw new NotFoundException('File not found');

    return this.getDownloadMetadata(fileRecord);
  }

  // ── Stream by Cookie ───────────────────────────────────────────────────

  /**
   * Lấy DownloadInfo cho stream — verify cookie subject khớp file owner
   */
  async getStreamInfoByOwner(
    fileId: string,
    cookieSubject: string,
  ): Promise<DownloadInfo> {
    const fileRecord = await this.prisma.fileRecord.findFirst({
      where: {
        id: fileId,
        userId: cookieSubject,
        status: 'complete',
        deletedAt: null,
      },
      include: { chunks: { orderBy: { chunkIndex: 'asc' } } },
    });
    if (!fileRecord) throw new NotFoundException('File not found');

    return this.getDownloadMetadata(fileRecord);
  }

  /**
   * Lấy DownloadInfo cho stream shared file (guest — không cần verify owner)
   */
  async getShareStreamInfo(shareToken: string): Promise<DownloadInfo> {
    return this.getDownloadInfoByToken(shareToken);
  }

  /**
   * Lấy DownloadInfo cho stream bởi guest (không verify owner, chỉ check file tồn tại + complete)
   */
  async getStreamInfoByGuest(fileId: string): Promise<DownloadInfo> {
    const fileRecord = await this.prisma.fileRecord.findFirst({
      where: {
        id: fileId,
        status: 'complete',
        deletedAt: null,
        visibility: 'PUBLIC_LINK',
      },
      include: { chunks: { orderBy: { chunkIndex: 'asc' } } },
    });
    if (!fileRecord)
      throw new NotFoundException('File not found or not shared');

    return this.getDownloadMetadata(fileRecord);
  }

  /**
   * Kiểm tra quota trước khi upload.
   * Throw 400 nếu usedSpace + fileSize > quota.
   */
  private async checkQuota(
    userId: string,
    fileSize: number | bigint,
  ): Promise<void> {
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
  async uploadFile(
    file: Express.Multer.File,
    userId: string,
    folderId?: string,
    conflictAction?: ConflictAction,
  ) {
    // Check quota trước khi upload lên Telegram
    await this.checkQuota(userId, file.size);

    const filename = Buffer.from(file.originalname, 'latin1').toString('utf8');

    // Check name conflict at destination
    const conflict = await this.nameConflictService.checkFileConflict(
      folderId || null,
      filename,
      userId,
    );

    let targetFilename = filename;
    if (conflict) {
      if (!conflictAction || conflictAction === 'skip') {
        throw new ConflictException({
          message:
            'A file or folder with this name already exists in the destination folder',
          type: 'file' as const,
          id: conflict.id,
          name: conflict.filename,
          suggestedName: await this.nameConflictService.generateUniqueName(
            filename,
            await this.nameConflictService.getExistingNames(
              folderId || null,
              userId,
            ),
          ),
        });
      }

      if (conflictAction === 'overwrite') {
        // Soft-delete file cũ
        await this.prisma.fileRecord.update({
          where: { id: conflict.id },
          data: { deletedAt: new Date() },
        });
        this.logger.log(
          `File overwritten during upload: "${conflict.filename}" (id: ${conflict.id}) soft-deleted`,
        );
      }

      if (conflictAction === 'rename') {
        // Auto-rename file mới
        const existingNames = await this.nameConflictService.getExistingNames(
          folderId || null,
          userId,
        );
        targetFilename = this.nameConflictService.generateUniqueName(
          filename,
          existingNames,
        );
        this.logger.log(
          `File auto-renamed during upload: "${filename}" to "${targetFilename}"`,
        );
      }
    }

    const dek = this.cryptoService.generateFileKey();
    const iv = this.cryptoService.generateIv();
    const encryptedKey = this.cryptoService.encryptKey(dek);

    // 1) Tạo placeholder FileRecord trước khi upload
    const record = await this.prisma.fileRecord.create({
      data: {
        filename: targetFilename,
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

    this.logger.log(
      `Starting upload to Telegram for file: "${targetFilename}" (${file.size} bytes)`,
    );

    try {
      // 2) Encrypt and Upload lên Telegram
      const cipher = this.cryptoService.createEncryptStream(dek, iv);
      const encryptedBuffer = Buffer.concat([
        cipher.update(file.buffer),
        cipher.final(),
      ]);
      // Use record.id as the Telegram filename to avoid leaking the real filename
      const {
        fileId: telegramFileId,
        messageId: telegramMessageId,
        botId,
      } = await this.telegram.uploadFile(encryptedBuffer, record.id);

      // 3) Thành công -> Update trạng thái và cộng dung lượng
      const updated = await this.prisma.$transaction(async (tx) => {
        const fileRecord = await tx.fileRecord.update({
          where: { id: record.id },
          data: {
            telegramFileId,
            telegramMessageId,
            botId,
            status: 'complete',
          },
        });

        await tx.user.update({
          where: { id: userId },
          data: { usedSpace: { increment: file.size } },
        });

        return fileRecord;
      });

      this.logger.log(
        `File uploaded: "${targetFilename}" (${file.size} bytes, userId: ${userId}, recordId: ${record.id})`,
      );
      return updated;
    } catch (err: unknown) {
      // Nếu lỗi upload, xoá placeholder record
      await this.prisma.fileRecord.delete({ where: { id: record.id } });
      this.logger.error(
        `Failed to upload file to Telegram: "${targetFilename}"`,
        err,
      );
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
    conflictAction?: ConflictAction,
  ) {
    // Check quota trước khi bắt đầu upload chunks
    await this.checkQuota(userId, size);

    // Check name conflict at destination
    const conflict = await this.nameConflictService.checkFileConflict(
      folderId || null,
      filename,
      userId,
    );

    let targetFilename = filename;
    if (conflict) {
      if (!conflictAction || conflictAction === 'skip') {
        throw new ConflictException({
          message:
            'A file or folder with this name already exists in the destination folder',
          type: 'file' as const,
          id: conflict.id,
          name: conflict.filename,
          suggestedName: await this.nameConflictService.generateUniqueName(
            filename,
            await this.nameConflictService.getExistingNames(
              folderId || null,
              userId,
            ),
          ),
        });
      }

      if (conflictAction === 'overwrite') {
        await this.prisma.fileRecord.update({
          where: { id: conflict.id },
          data: { deletedAt: new Date() },
        });
        this.logger.log(
          `File overwritten during chunked upload init: "${conflict.filename}" (id: ${conflict.id}) soft-deleted`,
        );
      }

      if (conflictAction === 'rename') {
        const existingNames = await this.nameConflictService.getExistingNames(
          folderId || null,
          userId,
        );
        targetFilename = this.nameConflictService.generateUniqueName(
          filename,
          existingNames,
        );
        this.logger.log(
          `File auto-renamed during chunked upload init: "${filename}" to "${targetFilename}"`,
        );
      }
    }

    const dek = this.cryptoService.generateFileKey();
    const iv = this.cryptoService.generateIv();
    const encryptedKey = this.cryptoService.encryptKey(dek);

    const record = await this.prisma.fileRecord.create({
      data: {
        filename: targetFilename,
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

    this.logger.log(
      `Chunked upload initialized: "${targetFilename}" (${size} bytes, ${totalChunks} chunks, userId: ${userId}, recordId: ${record.id})`,
    );
    return record;
  }

  /**
   * Upload chunk bằng stream pipe-through:
   *
   *   Client ──stream──▶ busboy ──pipe──▶ ByteCounter ──pipe──▶ Telegram
   *                (tất cả diễn ra đồng thời, không buffer toàn bộ chunk)
   */
  async uploadChunkStream(
    fileId: string,
    chunkIndex: number,
    userId: string,
    req: any,
  ): Promise<any> {
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
        this.logger.debug(
          `Client disconnected during chunk upload (file: ${fileId}, chunk: ${chunkIndex})`,
        );
        abortController.abort();
      }
    };
    socket?.on('close', onSocketClose);

    try {
      return await this._uploadChunkStreamInternal(
        fileId,
        chunkIndex,
        userId,
        req,
        abortController.signal,
      );
    } finally {
      settled = true;
      socket?.removeListener('close', onSocketClose);
      const current = this.activeUploads.get(userId) || 1;
      if (current <= 1) this.activeUploads.delete(userId);
      else this.activeUploads.set(userId, current - 1);
    }
  }

  private async _uploadChunkStreamInternal(
    fileId: string,
    chunkIndex: number,
    userId: string,
    req: any,
    signal?: AbortSignal,
  ): Promise<any> {
    const fileRecord = await this.prisma.fileRecord.findFirst({
      where: { id: fileId, userId, deletedAt: null },
    });
    if (!fileRecord) throw new NotFoundException('File record not found');
    if (fileRecord.status !== 'uploading')
      throw new BadRequestException('File upload already completed or aborted');
    if (chunkIndex < 0 || chunkIndex >= fileRecord.totalChunks) {
      throw new BadRequestException(
        `Invalid chunk index: ${chunkIndex}. Expected 0-${fileRecord.totalChunks - 1}`,
      );
    }

    // Idempotent: nếu chunk đã upload THÀNH CÔNG rồi, bỏ qua
    const existing = await this.prisma.fileChunk.findUnique({
      where: { fileId_chunkIndex: { fileId, chunkIndex } },
    });
    if (existing) {
      if (existing.telegramFileId && existing.telegramFileId !== '') {
        // Chunk already uploaded successfully — skip
        req.resume();
        this.logger.debug(
          `Chunk ${chunkIndex}/${fileRecord.totalChunks} already uploaded for file ${fileId}, skipping`,
        );
        return existing;
      }
      // Pending record from a failed attempt — delete it and retry
      await this.prisma.fileChunk.delete({ where: { id: existing.id } });
      this.logger.debug(
        `Deleted stale pending chunk ${chunkIndex} for file ${fileId}, retrying`,
      );
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
          const cipherStream = this.cryptoService.createEncryptStream(
            dek,
            chunkIv,
          );
          dataStream = stream.pipe(cipherStream);
        }

        dataStream.on('data', (buf: Buffer) => {
          chunks.push(buf);
          rawBytes += buf.length;
          if (rawBytes > MAX_CHUNK_SIZE) {
            stream.destroy();
            reject(
              new BadRequestException(
                `Chunk size exceeds maximum allowed size (${MAX_CHUNK_SIZE} bytes)`,
              ),
            );
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

          this.logger.log(
            `Starting chunk upload to Telegram: ${chunkIndex + 1}/${fileRecord.totalChunks} for file "${fileRecord.filename}" (${fileRecord.id}), ${rawBytes} bytes`,
          );

          // Create pending DB record BEFORE uploading to Telegram
          this.prisma.fileChunk
            .create({
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
              return this.telegram
                .uploadFile(buffer, chunkFilename, signal)
                .then(
                  async ({
                    fileId: telegramFileId,
                    messageId: telegramMessageId,
                    botId,
                  }) => {
                    try {
                      // Update with real Telegram IDs
                      const updated = await this.prisma.fileChunk.update({
                        where: { id: pendingChunk.id },
                        data: { telegramFileId, telegramMessageId, botId },
                      });

                      // Check if file was aborted while we were uploading
                      const currentFile =
                        await this.prisma.fileRecord.findUnique({
                          where: { id: fileId },
                          select: { status: true },
                        });
                      if (!currentFile || currentFile.status === 'aborted') {
                        this.logger.warn(
                          `Chunk ${chunkIndex} for file ${fileId} completed but file was aborted — deleting Telegram message ${telegramMessageId}`,
                        );
                        this.telegram
                          .deleteMessage(telegramMessageId)
                          .catch(() => {});
                        reject(new Error('Upload aborted'));
                        return;
                      }

                      this.logger.debug(
                        `Chunk uploaded: ${chunkIndex + 1}/${fileRecord.totalChunks} for file ${fileId} (${rawBytes} bytes)`,
                      );
                      resolve(updated);
                    } catch (updateErr: any) {
                      // Race A: Record was cascade-deleted by abort — clean up the orphaned Telegram message
                      if (updateErr?.code === 'P2025') {
                        this.logger.warn(
                          `Chunk ${chunkIndex} for file ${fileId} was aborted during upload — deleting orphaned Telegram message ${telegramMessageId}`,
                        );
                        this.telegram
                          .deleteMessage(telegramMessageId)
                          .catch(() => {});
                        reject(new Error('Upload aborted'));
                        return;
                      }
                      reject(updateErr);
                    }
                  },
                );
            })
            .catch((err) => {
              // Clean up pending record if upload fails
              this.prisma.fileChunk
                .deleteMany({
                  where: { fileId, chunkIndex },
                })
                .catch(() => {});
              this.logger.error(
                `Chunk upload failed: ${chunkIndex}/${fileRecord.totalChunks} for file ${fileId}: ${err.message}`,
              );
              reject(err);
            });
        });
      });

      bb.on('error', (err: Error) => reject(err));

      bb.on('close', () => {
        if (!fileProcessed) {
          reject(
            new BadRequestException('No file field received in the request'),
          );
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
      throw new BadRequestException(
        'Cannot abort a completed upload. Use DELETE instead.',
      );
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
      fileRecord.chunks
        .filter((c) => c.telegramMessageId)
        .map((c) => c.telegramMessageId),
    );
    for (const chunk of latestChunks) {
      if (
        chunk.telegramMessageId &&
        !alreadyDeleted.has(chunk.telegramMessageId)
      ) {
        await this.telegram.deleteMessage(chunk.telegramMessageId);
      }
    }

    await this.prisma.fileRecord.delete({ where: { id: fileId } });

    this.logger.warn(
      `Upload aborted: "${fileRecord.filename}" (fileId: ${fileId}, cleaned up ${latestChunks.length} chunks)`,
    );
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

    this.logger.log(
      `Chunked upload completed: "${fileRecord.filename}" (fileId: ${fileId}, ${fileRecord.totalChunks} chunks, ${fileRecord.size} bytes)`,
    );
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
    if (fileRecord.status !== 'complete')
      throw new BadRequestException('File upload not completed yet');

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
    if (!fileRecord || fileRecord.deletedAt)
      throw new NotFoundException('Shared file not found');
    if (fileRecord.status !== 'complete')
      throw new BadRequestException('File upload not completed yet');

    return this.getDownloadMetadata(fileRecord);
  }

  /**
   * Helper trích xuất metadata download từ FileRecord (không resolve URL — URL được resolve lazily khi stream)
   */
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
    chunks: Array<{
      id: string;
      telegramFileId: string;
      botId: bigint;
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
    botId: bigint,
    telegramMessageId: number | null,
    chunkDbId: string | null,
    context?: string,
  ): Promise<string> {
    if (this.telegram.isBotAvailable(botId)) {
      return this.telegram.getFileLink(telegramFileId, botId, context);
    }
    // Bot unavailable → recover via forwardMessage
    if (!telegramMessageId) {
      throw new Error(`Bot ${botId} unavailable and no messageId for recovery`);
    }
    this.logger.warn(
      `Bot ${botId} unavailable, recovering via forward (messageId: ${telegramMessageId})`,
    );
    const { fileId: newFileId, botId: newBotId } =
      await this.telegram.recoverFileId(telegramMessageId);
    // Cập nhật DB (fire-and-forget, không block download)
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

  /**
   * Admin: re-index all chunks/files whose bot is no longer available.
   */
  async reindexUnavailableBots(): Promise<{
    recovered: number;
    failed: number;
  }> {
    const availableIds = this.telegram.availableBotIds;

    const staleChunks = await this.prisma.fileChunk.findMany({
      where: { botId: { notIn: availableIds } },
    });
    const staleFiles = await this.prisma.fileRecord.findMany({
      where: {
        isChunked: false,
        telegramMessageId: { not: null },
        botId: { notIn: availableIds },
      },
    });

    let recovered = 0;
    let failed = 0;

    for (const chunk of staleChunks) {
      try {
        if (!chunk.telegramMessageId) {
          failed++;
          continue;
        }
        const { fileId, botId } = await this.telegram.recoverFileId(
          chunk.telegramMessageId,
        );
        await this.prisma.fileChunk.update({
          where: { id: chunk.id },
          data: { telegramFileId: fileId, botId },
        });
        recovered++;
      } catch {
        failed++;
      }
    }

    for (const file of staleFiles) {
      try {
        if (!file.telegramMessageId) {
          failed++;
          continue;
        }
        const { fileId, botId } = await this.telegram.recoverFileId(
          file.telegramMessageId,
        );
        await this.prisma.fileRecord.update({
          where: { id: file.id },
          data: { telegramFileId: fileId, botId },
        });
        recovered++;
      } catch {
        failed++;
      }
    }

    this.logger.log(
      `Reindex complete: ${recovered} recovered, ${failed} failed`,
    );
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

  /**
   * Helper process download file (dùng Streams)
   * Resolve URLs lazily: stream chunk[i] trong khi prefetch URL cho chunk[i+1..i+PREFETCH_AHEAD]
   */
  async processDownload(
    downloadInfo: DownloadInfo,
    res: Response,
    rangeHeader?: string,
  ) {
    // Multi-thread download: nếu có Range header và tính năng được bật → delegate sang processRangeDownload
    if (rangeHeader && (await this.isMultiThreadEnabled())) {
      return this.processRangeDownload(downloadInfo, rangeHeader, res);
    }

    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${encodeURIComponent(downloadInfo.filename)}"`,
    );
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Length', downloadInfo.size.toString());

    // Thêm Accept-Ranges nếu multi-thread download được bật
    if (await this.isMultiThreadEnabled()) {
      res.setHeader('Accept-Ranges', 'bytes');
    }

    if (!downloadInfo.isChunked) {
      const url = await this.resolveFileLink(
        downloadInfo.telegramFileId,
        downloadInfo.botId,
        downloadInfo.telegramMessageId,
        null,
      );
      const fetchRes = await fetchWithRetry(url);
      if (!fetchRes.ok || !fetchRes.body) {
        this.logger.error(
          `Failed to fetch file from Telegram: "${downloadInfo.filename}" (status: ${fetchRes.status}, url: ${url})`,
        );
        res.status(500).send('Trích xuất file từ Telegram thất bại');
        return;
      }

      try {
        await this.pipeStreamToResponse(fetchRes.body, res, {
          decrypt:
            downloadInfo.isEncrypted && downloadInfo.dek && downloadInfo.iv
              ? { dek: downloadInfo.dek, iv: downloadInfo.iv }
              : undefined,
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
    } else {
      try {
        const chunks = downloadInfo.chunks;
        const totalChunks = chunks.length;

        for (let i = 0; i < totalChunks; i++) {
          // Prefetch URLs cho các chunk tiếp theo (fire-and-forget, chúng sẽ được cache)
          for (
            let p = i + 1;
            p < Math.min(i + 1 + this.PREFETCH_AHEAD, totalChunks);
            p++
          ) {
            this.resolveFileLink(
              chunks[p].telegramFileId,
              chunks[p].botId,
              chunks[p].telegramMessageId,
              chunks[p].id,
              `prefetch chunk ${p + 1}/${totalChunks} of "${downloadInfo.filename}"`,
            );
          }

          // Resolve URL cho chunk hiện tại (instant nếu đã prefetch/cache)
          const url = await this.resolveFileLink(
            chunks[i].telegramFileId,
            chunks[i].botId,
            chunks[i].telegramMessageId,
            chunks[i].id,
            `chunk ${i + 1}/${totalChunks} of "${downloadInfo.filename}"`,
          );

          const fetchRes = await fetchWithRetry(url);
          if (!fetchRes.ok || !fetchRes.body) {
            throw new Error(
              `Failed to fetch chunk ${i + 1}/${totalChunks} from Telegram`,
            );
          }

          await this.pipeStreamToResponse(fetchRes.body, res, {
            decrypt:
              downloadInfo.isEncrypted && downloadInfo.dek && chunks[i].iv
                ? { dek: downloadInfo.dek, iv: chunks[i].iv! }
                : undefined,
          });
        }
        res.end();
      } catch (error: unknown) {
        if (this.isClientDisconnect(error)) {
          this.logger.debug(
            `Client disconnected during chunked download: "${downloadInfo.filename}"`,
          );
        } else {
          this.logger.error(
            `Chunked download failed: "${downloadInfo.filename}"`,
            error instanceof Error ? error.stack : String(error),
          );
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
  async processStream(
    downloadInfo: DownloadInfo,
    rangeHeader: string | undefined,
    res: Response,
  ) {
    return this.processRangeRequest(downloadInfo, rangeHeader, res, 'inline');
  }

  /**
   * Download với Range header (cho multi-thread download managers như IDM)
   * Giống processStream nhưng giữ Content-Disposition: attachment
   */
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

  /**
   * Unified range/stream handler — merges the previously duplicated processStream
   * and processRangeDownload methods.
   *
   * disposition = 'inline'     → streaming (video/audio player)
   * disposition = 'attachment' → file download (IDM multi-thread)
   */
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

    if (!downloadInfo.isChunked) {
      const url = await this.resolveFileLink(
        downloadInfo.telegramFileId,
        downloadInfo.botId,
        downloadInfo.telegramMessageId,
        null,
      );
      const fetchRes = await fetchWithRetry(url, {
        headers: { Range: `bytes=${start}-${end}` },
      });
      if (!fetchRes.ok || !fetchRes.body) {
        this.logger.error(
          `Failed to fetch from Telegram: "${downloadInfo.filename}"`,
        );
        return res.status(500).end();
      }

      try {
        await this.pipeStreamToResponse(fetchRes.body, res, {
          decrypt:
            downloadInfo.isEncrypted && downloadInfo.dek && downloadInfo.iv
              ? { dek: downloadInfo.dek, iv: downloadInfo.iv, offset: start }
              : undefined,
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
    } else {
      let currentOffset = 0;
      const chunksToFetch: {
        telegramFileId: string;
        botId: bigint;
        telegramMessageId: number | null;
        id: string | null;
        iv: Buffer | null;
        size: number;
        fetchStart: number;
        fetchEnd: number;
        byteOffsetInChunk: number;
      }[] = [];

      for (const chunk of downloadInfo.chunks) {
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
          });
        }
        currentOffset += chunk.size;
      }

      try {
        for (let i = 0; i < chunksToFetch.length; i++) {
          const chunkReq = chunksToFetch[i];

          // Prefetch URLs cho các chunk tiếp theo
          for (
            let p = i + 1;
            p < Math.min(i + 1 + this.PREFETCH_AHEAD, chunksToFetch.length);
            p++
          ) {
            this.resolveFileLink(
              chunksToFetch[p].telegramFileId,
              chunksToFetch[p].botId,
              chunksToFetch[p].telegramMessageId,
              chunksToFetch[p].id,
            );
          }

          const url = await this.resolveFileLink(
            chunkReq.telegramFileId,
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

          await this.pipeStreamToResponse(fetchRes.body, res, {
            decrypt:
              downloadInfo.isEncrypted && downloadInfo.dek && chunkReq.iv
                ? {
                    dek: downloadInfo.dek,
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
            `Client disconnected during ${disposition}: "${downloadInfo.filename}"`,
          );
        } else {
          this.logger.error(
            `${disposition} error: "${downloadInfo.filename}"`,
            err instanceof Error ? err.message : String(err),
          );
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
      select: { id: true, filename: true, folderId: true },
    });
    if (!fileRecord) throw new NotFoundException('File not found');

    const conflict = await this.nameConflictService.checkFileConflict(
      fileRecord.folderId,
      newName,
      userId,
      id,
    );
    if (conflict) {
      throw new ConflictException({
        message:
          'A file or folder with this name already exists in the current folder',
        type: 'file' as const,
      });
    }

    const updated = await this.prisma.fileRecord.update({
      where: { id },
      data: { filename: newName },
    });

    this.logger.log(
      `File renamed: "${fileRecord.filename}" to "${newName}" (fileId: ${id})`,
    );
    return updated;
  }

  /**
   * Di chuyển file
   */
  async move(
    id: string,
    newFolderId: string | null,
    userId: string,
    conflictAction?: ConflictAction,
  ) {
    const fileRecord = await this.prisma.fileRecord.findFirst({
      where: { id, userId, deletedAt: null },
      select: { id: true, filename: true, folderId: true },
    });
    if (!fileRecord) throw new NotFoundException('File not found');

    if (newFolderId) {
      const folder = await this.prisma.folder.findFirst({
        where: { id: newFolderId, userId, deletedAt: null },
        select: { id: true },
      });
      if (!folder) throw new NotFoundException('Destination folder not found');
    }

    // Check conflict at destination
    const conflict = await this.nameConflictService.checkFileConflict(
      newFolderId,
      fileRecord.filename,
      userId,
      id,
    );

    if (conflict) {
      // Default: throw conflict error for web UI to handle
      if (!conflictAction || conflictAction === 'skip') {
        throw new ConflictException({
          message:
            'A file or folder with this name already exists in the destination folder',
          type: 'file' as const,
          id: conflict.id,
          name: conflict.filename,
          suggestedName: await this.nameConflictService.generateUniqueName(
            fileRecord.filename,
            await this.nameConflictService.getExistingNames(
              newFolderId,
              userId,
            ),
          ),
        });
      }

      if (conflictAction === 'overwrite') {
        // Soft-delete file cũ, sau đó move file mới vào
        await this.prisma.fileRecord.update({
          where: { id: conflict.id },
          data: { deletedAt: new Date() },
        });
        this.logger.log(
          `File overwrite during move: "${conflict.filename}" (id: ${conflict.id}) soft-deleted`,
        );
      }

      if (conflictAction === 'rename') {
        // Auto-rename file cần move
        const existingNames = await this.nameConflictService.getExistingNames(
          newFolderId,
          userId,
        );
        const uniqueName = this.nameConflictService.generateUniqueName(
          fileRecord.filename,
          existingNames,
        );
        await this.prisma.fileRecord.update({
          where: { id },
          data: { filename: uniqueName },
        });
        this.logger.log(
          `File auto-renamed during move: "${fileRecord.filename}" to "${uniqueName}" (fileId: ${id})`,
        );
      }
    }

    const updated = await this.prisma.fileRecord.update({
      where: { id },
      data: { folderId: newFolderId },
    });

    this.logger.log(
      `File moved: "${fileRecord.filename}" (fileId: ${id}) to folder: ${newFolderId || 'root'}`,
    );
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

    const shareToken =
      fileRecord.shareToken || crypto.randomBytes(16).toString('hex');

    const updated = await this.prisma.fileRecord.update({
      where: { id },
      data: {
        visibility: 'PUBLIC_LINK',
        shareToken,
      },
    });

    this.logger.log(
      `File shared: "${fileRecord.filename}" (fileId: ${id}, token: ${shareToken})`,
    );
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

    await this.purgeFilesFromTelegram([fileRecord]);

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

    this.logger.log(
      `File deleted: "${fileRecord.filename}" (fileId: ${id}, chunks: ${fileRecord.chunks.length}, freed: ${fileRecord.size} bytes)`,
    );
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

    this.logger.log(
      `File soft-deleted: "${fileRecord.filename}" (fileId: ${id}, userId: ${userId})`,
    );
    return updated;
  }

  /**
   * Khôi phục file từ thùng rác.
   * Nếu tên bị chiếm tại vị trí cũ → auto-rename + trả về suggested name.
   */
  async restore(
    id: string,
    userId: string,
  ): Promise<{ file: { id: string; filename: string }; autoRenamed: boolean }> {
    const fileRecord = await this.prisma.fileRecord.findFirst({
      where: { id, userId, deletedAt: { not: null } },
    });
    if (!fileRecord) throw new NotFoundException('File not found in trash');

    // Check nếu tên file bị chiếm tại vị trí cũ (folderId)
    const conflict = await this.nameConflictService.checkFileConflict(
      fileRecord.folderId,
      fileRecord.filename,
      userId,
      id,
    );

    let autoRenamed = false;
    let finalFilename = fileRecord.filename;

    if (conflict) {
      const existingNames = await this.nameConflictService.getExistingNames(
        fileRecord.folderId,
        userId,
      );
      finalFilename = this.nameConflictService.generateUniqueName(
        fileRecord.filename,
        existingNames,
      );
      autoRenamed = true;
      this.logger.log(
        `File restore auto-renamed: "${fileRecord.filename}" to "${finalFilename}" (fileId: ${id})`,
      );
    }

    const updated = await this.prisma.fileRecord.update({
      where: { id },
      data: {
        deletedAt: null,
        ...(autoRenamed && { filename: finalFilename }),
      },
    });

    this.logger.log(
      `File restored: "${updated.filename}" (fileId: ${id}, userId: ${userId})`,
    );
    return { file: updated, autoRenamed };
  }

  /**
   * Xoá vĩnh viễn file từ thùng rác — xoá trên Telegram + DB + hoàn trả usedSpace.
   */
  async permanentDelete(id: string, userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { isCleaningTrash: true },
    });
    if (user?.isCleaningTrash) {
      throw new ConflictException('Trash cleanup is in progress');
    }

    const releaseLock = await this.acquireDeletionLock(userId);
    try {
      const fileRecord = await this.prisma.fileRecord.findFirst({
        where: { id, userId, deletedAt: { not: null } },
        include: { chunks: true },
      });
      if (!fileRecord) throw new NotFoundException('File not found in trash');

      await this.purgeFilesFromTelegram([fileRecord]);

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

      this.logger.log(
        `File permanently deleted: "${fileRecord.filename}" (fileId: ${id}, freed: ${fileRecord.size} bytes)`,
      );
    } finally {
      releaseLock();
    }
  }

  /**
   * Xoá hàng loạt files vĩnh viễn (sử dụng khi xoá folder) - xoá Telegram, DB, và trừ usedSpace trong 1 transaction.
   */
  async bulkPermanentDeleteFiles(fileIds: string[], userId: string) {
    if (fileIds.length === 0) return 0n;

    const releaseLock = await this.acquireDeletionLock(userId);
    try {
      const files = await this.prisma.fileRecord.findMany({
        where: { id: { in: fileIds }, userId },
        include: { chunks: true },
      });

      if (files.length === 0) return 0n;

      let freedSize = BigInt(0);
      for (const file of files) {
        if (file.status === 'complete') {
          freedSize += file.size;
        }
      }

      await this.purgeFilesFromTelegram(files);

      await this.prisma.$transaction(async (tx) => {
        await tx.fileRecord.deleteMany({
          where: { id: { in: fileIds } },
        });

        if (freedSize > 0n) {
          await tx.user.update({
            where: { id: userId },
            data: { usedSpace: { decrement: freedSize } },
          });
        }
      });

      this.logger.log(
        `Bulk permanently deleted ${files.length} files, freed: ${freedSize} bytes`,
      );
      return freedSize;
    } finally {
      releaseLock();
    }
  }

  /**
   * Dọn sạch toàn bộ thùng rác (files và folders)
   */
  async emptyTrash(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { isCleaningTrash: true },
    });
    if (user?.isCleaningTrash) {
      throw new ConflictException('Trash cleanup is in progress');
    }

    const releaseLock = await this.acquireDeletionLock(userId);
    try {
      const files = await this.prisma.fileRecord.findMany({
        where: { userId, deletedAt: { not: null } },
        include: { chunks: true },
      });

      const folders = await this.prisma.folder.findMany({
        where: { userId, deletedAt: { not: null } },
        select: { id: true },
      });

      if (files.length === 0 && folders.length === 0) {
        return { success: true, count: 0, freedSize: 0 };
      }

      let freedSize = BigInt(0);
      const fileIds = files.map((f) => f.id);
      const folderIds = folders.map((f) => f.id);

      for (const file of files) {
        if (file.status === 'complete') freedSize += file.size;
      }

      await this.purgeFilesFromTelegram(files);

      await this.prisma.$transaction(async (tx) => {
        if (fileIds.length > 0) {
          await tx.fileRecord.deleteMany({
            where: { id: { in: fileIds } },
          });
        }

        if (folderIds.length > 0) {
          await tx.folder.deleteMany({
            where: { id: { in: folderIds } },
          });
        }

        if (freedSize > 0n) {
          await tx.user.update({
            where: { id: userId },
            data: { usedSpace: { decrement: freedSize } },
          });
        }
      });

      this.logger.log(
        `Emptied trash for userId ${userId}: ${files.length} files, ${folders.length} folders, freed: ${freedSize} bytes`,
      );
      return {
        success: true,
        count: files.length + folders.length,
        freedSize: freedSize.toString(),
      };
    } finally {
      releaseLock();
    }
  }

  // ── Telegram Cleanup Helper ────────────────────────────────────────────

  /**
   * Xoá tất cả Telegram messages liên quan đến danh sách files.
   * Dùng chung bởi delete(), permanentDelete(), bulkPermanentDeleteFiles(), emptyTrash().
   * Tránh lặp code pattern: xoá main message + chunks messages.
   */
  async purgeFilesFromTelegram(
    files: Array<{
      telegramMessageId: number | null;
      chunks: Array<{ telegramMessageId: number | null }>;
    }>,
  ): Promise<void> {
    const messageIds: number[] = [];
    for (const file of files) {
      if (file.telegramMessageId) messageIds.push(file.telegramMessageId);
      for (const chunk of file.chunks) {
        if (chunk.telegramMessageId) messageIds.push(chunk.telegramMessageId);
      }
    }

    for (const msgId of messageIds) {
      try {
        await this.telegram.deleteMessage(msgId);
        // Delay nhỏ để tránh rate-limit nếu số lượng lớn
        if (messageIds.length > 5) {
          await new Promise((res) => setTimeout(res, 50));
        }
      } catch (err) {
        this.logger.warn(`Failed to delete Telegram message ${msgId}: ${err}`);
      }
    }
  }

  // ── Upload From Buffer / Stream (cho S3 và các module khác) ────────────

  /**
   * Upload file từ Buffer — encrypt + upload Telegram + tạo/update FileRecord + cộng usedSpace.
   * Dùng bởi S3Controller.doPutObject() để tránh trùng lặp logic upload.
   *
   * @param existingFileId Nếu có, update record hiện tại (overwrite). Nếu null, tạo mới.
   */
  async uploadFromBuffer(params: {
    buffer: Buffer;
    filename: string;
    mimeType: string;
    userId: string;
    folderId?: string | null;
    existingFileId?: string;
    etag?: string;
    signal?: AbortSignal;
  }) {
    const {
      buffer,
      filename,
      mimeType,
      userId,
      folderId,
      existingFileId,
      etag,
      signal,
    } = params;

    const oldRecord = existingFileId
      ? await this.prisma.fileRecord.findUnique({
          where: { id: existingFileId },
          include: { chunks: true },
        })
      : null;

    const quotaDelta = BigInt(buffer.length) - (oldRecord?.size ?? 0n);
    if (quotaDelta > 0n) {
      await this.checkQuota(userId, quotaDelta);
    }

    const dek = this.cryptoService.generateFileKey();
    const iv = this.cryptoService.generateIv();
    const encryptedKey = this.cryptoService.encryptKey(dek);

    // Encrypt buffer
    const cipher = this.cryptoService.createEncryptStream(dek, iv);
    const encryptedBuffer = Buffer.concat([
      cipher.update(buffer),
      cipher.final(),
    ]);

    if (existingFileId) {
      // Update existing file (S3 overwrite)
      // Upload to Telegram
      const {
        fileId: telegramFileId,
        messageId: telegramMessageId,
        botId,
      } = await this.telegram.uploadFile(
        encryptedBuffer,
        existingFileId,
        signal,
      );

      // Delete old Telegram messages
      if (oldRecord) {
        await this.purgeFilesFromTelegram([oldRecord]);
      }

      // Transaction: update record + adjust usedSpace
      const updated = await this.prisma.$transaction(async (tx) => {
        const oldSize = oldRecord?.size ?? 0n;
        const newSize = BigInt(buffer.length);
        const sizeDiff = newSize - oldSize;

        const record = await tx.fileRecord.update({
          where: { id: existingFileId },
          data: {
            filename,
            mimeType,
            size: newSize,
            telegramFileId,
            telegramMessageId,
            botId,
            isChunked: false,
            totalChunks: 1,
            status: 'complete',
            isEncrypted: true,
            encryptionAlgo: 'aes-256-ctr',
            encryptionIv: iv.toString('hex'),
            encryptedKey,
            etag,
          },
        });

        if (sizeDiff !== 0n) {
          await tx.user.update({
            where: { id: userId },
            data: { usedSpace: { increment: sizeDiff } },
          });
        }

        return record;
      });

      this.logger.log(
        `File overwritten via uploadFromBuffer: "${filename}" (${buffer.length} bytes, userId: ${userId})`,
      );
      return updated;
    } else {
      // Create new record
      const record = await this.prisma.fileRecord.create({
        data: {
          filename,
          size: buffer.length,
          mimeType,
          telegramFileId: null,
          telegramMessageId: null,
          isChunked: false,
          totalChunks: 1,
          status: 'uploading',
          isEncrypted: true,
          encryptionAlgo: 'aes-256-ctr',
          encryptionIv: iv.toString('hex'),
          encryptedKey,
          etag,
          folderId: folderId || null,
          userId,
        },
      });

      try {
        const {
          fileId: telegramFileId,
          messageId: telegramMessageId,
          botId,
        } = await this.telegram.uploadFile(encryptedBuffer, record.id, signal);

        const updated = await this.prisma.$transaction(async (tx) => {
          const fileRecord = await tx.fileRecord.update({
            where: { id: record.id },
            data: {
              telegramFileId,
              telegramMessageId,
              botId,
              status: 'complete',
            },
          });

          await tx.user.update({
            where: { id: userId },
            data: { usedSpace: { increment: buffer.length } },
          });

          return fileRecord;
        });

        this.logger.log(
          `File uploaded via uploadFromBuffer: "${filename}" (${buffer.length} bytes, userId: ${userId})`,
        );
        return updated;
      } catch (err) {
        await this.prisma.fileRecord.delete({ where: { id: record.id } });
        throw err;
      }
    }
  }

  /**
   * Upload file từ Readable stream — encrypt + upload Telegram + tạo/update FileRecord + cộng usedSpace.
   * Dùng bởi S3Controller cho large files.
   *
   * @param existingFileId Nếu có, update record hiện tại (overwrite). Nếu null, tạo mới.
   */
  async uploadFromStream(params: {
    stream: Readable;
    filename: string;
    mimeType: string;
    size: number;
    userId: string;
    folderId?: string | null;
    existingFileId?: string;
    signal?: AbortSignal;
  }) {
    const {
      stream,
      filename,
      mimeType,
      size,
      userId,
      folderId,
      existingFileId,
      signal,
    } = params;

    const oldRecord = existingFileId
      ? await this.prisma.fileRecord.findUnique({
          where: { id: existingFileId },
          include: { chunks: true },
        })
      : null;

    const quotaDelta = BigInt(size) - (oldRecord?.size ?? 0n);
    if (quotaDelta > 0n) {
      await this.checkQuota(userId, quotaDelta);
    }

    const dek = this.cryptoService.generateFileKey();
    const iv = this.cryptoService.generateIv();
    const encryptedKey = this.cryptoService.encryptKey(dek);

    // Pipe through encryption
    const cipher = this.cryptoService.createEncryptStream(dek, iv);
    const encryptedStream = stream.pipe(cipher);

    if (existingFileId) {
      const {
        fileId: telegramFileId,
        messageId: telegramMessageId,
        botId,
      } = await this.telegram.uploadStream(
        encryptedStream,
        existingFileId,
        signal,
      );

      if (oldRecord) {
        await this.purgeFilesFromTelegram([oldRecord]);
      }

      const updated = await this.prisma.$transaction(async (tx) => {
        const oldSize = oldRecord?.size ?? 0n;
        const newSize = BigInt(size);
        const sizeDiff = newSize - oldSize;

        const record = await tx.fileRecord.update({
          where: { id: existingFileId },
          data: {
            filename,
            mimeType,
            size: newSize,
            telegramFileId,
            telegramMessageId,
            botId,
            isChunked: false,
            totalChunks: 1,
            status: 'complete',
            isEncrypted: true,
            encryptionAlgo: 'aes-256-ctr',
            encryptionIv: iv.toString('hex'),
            encryptedKey,
          },
        });

        if (sizeDiff !== 0n) {
          await tx.user.update({
            where: { id: userId },
            data: { usedSpace: { increment: sizeDiff } },
          });
        }

        return record;
      });

      this.logger.log(
        `File overwritten via uploadFromStream: "${filename}" (${size} bytes, userId: ${userId})`,
      );
      return updated;
    } else {
      const record = await this.prisma.fileRecord.create({
        data: {
          filename,
          size,
          mimeType,
          telegramFileId: null,
          telegramMessageId: null,
          isChunked: false,
          totalChunks: 1,
          status: 'uploading',
          isEncrypted: true,
          encryptionAlgo: 'aes-256-ctr',
          encryptionIv: iv.toString('hex'),
          encryptedKey,
          folderId: folderId || null,
          userId,
        },
      });

      try {
        const {
          fileId: telegramFileId,
          messageId: telegramMessageId,
          botId,
        } = await this.telegram.uploadStream(
          encryptedStream,
          record.id,
          signal,
        );

        const updated = await this.prisma.$transaction(async (tx) => {
          const fileRecord = await tx.fileRecord.update({
            where: { id: record.id },
            data: {
              telegramFileId,
              telegramMessageId,
              botId,
              status: 'complete',
            },
          });

          await tx.user.update({
            where: { id: userId },
            data: { usedSpace: { increment: size } },
          });

          return fileRecord;
        });

        this.logger.log(
          `File uploaded via uploadFromStream: "${filename}" (${size} bytes, userId: ${userId})`,
        );
        return updated;
      } catch (err) {
        await this.prisma.fileRecord.delete({ where: { id: record.id } });
        throw err;
      }
    }
  }

  /**
   * Danh sách file trong thùng rác của user.
   * Chỉ hiển thị các file trực tiếp bị xoá (không hiển thị các file con của 1 folder đã bị xoá).
   */
  async listTrash(
    userId: string,
    pagination: PaginationQueryDto,
  ): Promise<PaginatedResponse<unknown>> {
    const limit = pagination.limit ?? 20;
    const where: Record<string, unknown> = {
      userId,
      deletedAt: { not: null },
      OR: [{ folderId: null }, { folder: { deletedAt: null } }],
    };

    if (pagination.search) {
      where.filename = { contains: pagination.search, mode: 'insensitive' };
    }

    if (pagination.cursor) {
      try {
        const decoded = Buffer.from(pagination.cursor, 'base64').toString(
          'utf-8',
        );
        const [timestamp, id] = decoded.split('_');
        where.OR = [
          { deletedAt: { lt: new Date(timestamp) } },
          { deletedAt: new Date(timestamp), id: { lt: id } },
        ];
      } catch {
        // Invalid cursor, ignore
      }
    }

    const data = await this.prisma.fileRecord.findMany({
      where,
      orderBy: [{ deletedAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      select: {
        id: true,
        filename: true,
        size: true,
        mimeType: true,
        deletedAt: true,
        createdAt: true,
        folderId: true,
        userId: true,
      },
    });

    const hasNext = data.length > limit;
    const items = hasNext ? data.slice(0, -1) : data;
    const nextCursor = hasNext
      ? Buffer.from(
          `${(items[items.length - 1] as { deletedAt: Date }).deletedAt.toISOString()}_${(items[items.length - 1] as { id: string }).id}`,
        ).toString('base64')
      : null;

    const total = await this.prisma.fileRecord.count({ where });

    return { data: items, nextCursor, total };
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
