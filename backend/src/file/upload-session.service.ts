import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  HttpException,
  HttpStatus,
  ConflictException,
  Inject,
} from '@nestjs/common';
import { TEMP_STORAGE } from '../common/temp-storage';
import type { TempStorage } from '../common/temp-storage';
import { PrismaService } from '../prisma/prisma.service';
import { TelegramService } from '../telegram/telegram.service';
import { Readable, Transform } from 'stream';
import Busboy from 'busboy';
import { CryptoService } from '../crypto/crypto.service';
import { SettingsService } from '../settings/settings.service';
import { MAX_CHUNK_SIZE } from '../config/upload.config';
import {
  NameConflictService,
  ConflictAction,
} from '../common/name-conflict.service';

import { UploadBufferService } from './upload-buffer.service';
import { GrpcTransferClient } from '../grpc/grpc-transfer.client';

// When 'go', the Go transfer service owns all binary ingestion. The in-process
// direct-upload fallbacks here are disabled. Set to 'nest' to restore them.
const uploadIoOwnerIsGo = (): boolean =>
  (process.env.UPLOAD_IO_OWNER || 'go') === 'go';

@Injectable()
export class UploadSessionService {
  private readonly logger = new Logger(UploadSessionService.name);
  private readonly activeUploads = new Map<string, number>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly telegram: TelegramService,
    private readonly cryptoService: CryptoService,
    private readonly settingsService: SettingsService,
    private readonly nameConflictService: NameConflictService,
    private readonly uploadBufferService: UploadBufferService,
    @Inject(TEMP_STORAGE) private readonly tempStorage: TempStorage,
    private readonly transferClient: GrpcTransferClient,
  ) {}

  async getMaxConcurrentChunks(): Promise<number> {
    return this.settingsService.getCachedSetting(
      'MAX_CONCURRENT_CHUNKS',
      3,
      (v) => parseInt(v, 10),
    );
  }

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

  async uploadFile(
    file: Express.Multer.File,
    userId: string,
    folderId?: string,
    conflictAction?: ConflictAction,
  ) {
    await this.checkQuota(userId, file.size);

    const filename = Buffer.from(file.originalname, 'latin1').toString('utf8');
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
          `File overwritten during upload: "${conflict.filename}" (id: ${conflict.id}) soft-deleted`,
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
          `File auto-renamed during upload: "${filename}" to "${targetFilename}"`,
        );
      }
    }

    const dek = this.cryptoService.generateFileKey();
    const iv = this.cryptoService.generateIv();
    const encryptedKey = this.cryptoService.encryptKey(dek);

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
        encryptedKey,
        folderId: folderId || null,
        userId,
      },
    });

    this.logger.log(
      `Starting upload to Telegram for file: "${targetFilename}" (${file.size} bytes)`,
    );

    try {
      const cipher = this.cryptoService.createEncryptStream(dek, iv);
      const encryptedBuffer = Buffer.concat([
        cipher.update(file.buffer),
        cipher.final(),
      ]);
      const {
        fileId: telegramFileId,
        messageId: telegramMessageId,
        botId,
      } = await this.telegram.uploadFile(encryptedBuffer, record.id);

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
      await this.prisma.fileRecord.delete({ where: { id: record.id } });
      this.logger.error(
        `Failed to upload file to Telegram: "${targetFilename}"`,
        err,
      );
      throw err;
    }
  }

  async initChunkedUpload(
    filename: string,
    size: number,
    mimeType: string,
    totalChunks: number,
    userId: string,
    folderId?: string,
    conflictAction?: ConflictAction,
  ) {
    await this.checkQuota(userId, size);

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
        encryptedKey,
        folderId: folderId || null,
        userId,
      },
    });

    this.logger.log(
      `Chunked upload initialized: "${targetFilename}" (${size} bytes, ${totalChunks} chunks, userId: ${userId}, recordId: ${record.id})`,
    );
    return record;
  }

  async uploadChunkStream(
    fileId: string,
    chunkIndex: number,
    userId: string,
    req: any,
  ): Promise<any> {
    const maxConcurrent = await this.getMaxConcurrentChunks();
    const active = this.activeUploads.get(userId) || 0;
    if (active >= maxConcurrent) {
      const waitMs = await this.telegram.getWaitTimeMs();
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

    const abortController = new AbortController();
    let settled = false;
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
      return await this.uploadChunkStreamInternal(
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

  private async uploadChunkStreamInternal(
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
    if (fileRecord.status !== 'uploading') {
      throw new BadRequestException('File upload already completed or aborted');
    }
    if (chunkIndex < 0 || chunkIndex >= fileRecord.totalChunks) {
      throw new BadRequestException(
        `Invalid chunk index: ${chunkIndex}. Expected 0-${fileRecord.totalChunks - 1}`,
      );
    }

    const existing = await this.prisma.fileChunk.findUnique({
      where: { fileId_chunkIndex: { fileId, chunkIndex } },
    });
    if (existing) {
      if (existing.telegramFileId && existing.telegramFileId !== '') {
        req.resume();
        this.logger.debug(
          `Chunk ${chunkIndex}/${fileRecord.totalChunks} already uploaded for file ${fileId}, skipping`,
        );
        return existing;
      }
      await this.prisma.fileChunk.delete({ where: { id: existing.id } });
      this.logger.debug(
        `Deleted stale pending chunk ${chunkIndex} for file ${fileId}, retrying`,
      );
    }

    const chunkFilename = `${fileRecord.id}.part${String(chunkIndex).padStart(3, '0')}`;
    let dek: Buffer | null = null;
    let chunkIv: Buffer | null = null;
    if (fileRecord.isEncrypted && fileRecord.encryptedKey) {
      dek = this.cryptoService.decryptKey(fileRecord.encryptedKey);
      chunkIv = this.cryptoService.generateIv();
    }
    let rawBytes = 0;
    const counterTransform = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        rawBytes += chunk.length;
        if (rawBytes > MAX_CHUNK_SIZE) {
          callback(
            new BadRequestException(
              `Chunk size exceeds maximum allowed size (${MAX_CHUNK_SIZE} bytes)`,
            ),
          );
          return;
        }
        callback(null, chunk);
      },
    });

    const canBuffer =
      await this.uploadBufferService.shouldBuffer(MAX_CHUNK_SIZE);

    return new Promise<any>((resolve, reject) => {
      const bb = Busboy({ headers: req.headers });
      let fileProcessed = false;

      bb.on('file', (_name: string, stream: Readable) => {
        if (fileProcessed) {
          stream.resume();
          return;
        }
        fileProcessed = true;

        const performDirectUpload = (
          srcStream: Readable,
          initialRawBytes = 0,
        ) => {
          let dataStream: Readable = srcStream;
          if (initialRawBytes === 0) {
            dataStream = srcStream.pipe(counterTransform);
          } else {
            rawBytes = initialRawBytes;
          }
          if (dek && chunkIv) {
            const cipherStream = this.cryptoService.createEncryptStream(
              dek,
              chunkIv,
            );
            dataStream = dataStream.pipe(cipherStream);
          }

          dataStream.on('error', (err: Error) => reject(err));

          this.logger.log(
            `Starting streaming chunk upload: ${chunkIndex + 1}/${fileRecord.totalChunks} for file "${fileRecord.filename}" (${fileRecord.id})`,
          );

          this.prisma.fileChunk
            .create({
              data: {
                fileId,
                chunkIndex,
                size: 0,
                telegramFileId: '',
                telegramMessageId: null,
                ...(chunkIv && { encryptionIv: chunkIv.toString('hex') }),
              },
            })
            .then((pendingChunk) => {
              return this.telegram
                .uploadStream(dataStream, chunkFilename, signal)
                .then(
                  async ({
                    fileId: telegramFileId,
                    messageId: telegramMessageId,
                    botId,
                  }) => {
                    try {
                      const updated = await this.prisma.fileChunk.update({
                        where: { id: pendingChunk.id },
                        data: {
                          telegramFileId,
                          telegramMessageId,
                          botId,
                          size: rawBytes,
                        },
                      });

                      const currentFile =
                        await this.prisma.fileRecord.findUnique({
                          where: { id: fileId },
                          select: { status: true },
                        });
                      if (!currentFile || currentFile.status === 'aborted') {
                        this.logger.warn(
                          `Chunk ${chunkIndex} for file ${fileId} completed but file was aborted - deleting Telegram message ${telegramMessageId}`,
                        );
                        this.telegram
                          .deleteMessage(telegramMessageId, botId)
                          .catch(() => {});
                        reject(new Error('Upload aborted'));
                        return;
                      }

                      this.logger.debug(
                        `Chunk streamed: ${chunkIndex + 1}/${fileRecord.totalChunks} for file ${fileId}`,
                      );
                      resolve(updated);
                    } catch (updateErr: any) {
                      if (updateErr?.code === 'P2025') {
                        this.logger.warn(
                          `Chunk ${chunkIndex} for file ${fileId} was aborted during upload - deleting orphaned Telegram message ${telegramMessageId}`,
                        );
                        this.telegram
                          .deleteMessage(telegramMessageId, botId)
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
        };

        if (canBuffer) {
          this.logger.log(
            `Buffering chunk: ${chunkIndex + 1}/${fileRecord.totalChunks} for file "${fileRecord.filename}" (${fileRecord.id})`,
          );

          const chunksList: Buffer[] = [];
          stream.on('data', (c: Buffer) => chunksList.push(c));
          stream.on('end', async () => {
            try {
              const buffer = Buffer.concat(chunksList);
              try {
                const chunk = await this.uploadBufferService.acceptChunk({
                  buffer,
                  size: buffer.length,
                  fileRecordId: fileId,
                  chunkIndex,
                  userId,
                });
                resolve(chunk);
              } catch (bufferErr: any) {
                if (uploadIoOwnerIsGo()) {
                  // Go owns I/O — do not fall back to in-process Telegram upload.
                  this.logger.warn(
                    `Failed to buffer chunk ${chunkIndex + 1} for file ${fileId}: ${bufferErr.message}`,
                  );
                  reject(
                    new HttpException(
                      {
                        error: 'upload_buffer_full',
                        message:
                          'Upload buffer is temporarily full, please retry',
                        retryAfter: 5,
                      },
                      HttpStatus.SERVICE_UNAVAILABLE,
                    ),
                  );
                  return;
                }
                this.logger.warn(
                  `Failed to buffer chunk ${chunkIndex + 1} for file ${fileId}, falling back to direct upload: ${bufferErr.message}`,
                );
                performDirectUpload(Readable.from(buffer), buffer.length);
              }
            } catch (err) {
              reject(err);
            }
          });
          stream.on('error', (err) => reject(err));
          return;
        }

        if (uploadIoOwnerIsGo()) {
          // Cannot buffer and Go owns I/O. The chunk endpoint is routed to Go by
          // nginx, so this NestJS path should not normally be reached. Reject
          // rather than perform an in-process Telegram upload.
          stream.resume();
          reject(
            new HttpException(
              {
                error: 'upload_unavailable',
                message: 'Upload temporarily unavailable, please retry',
                retryAfter: 5,
              },
              HttpStatus.SERVICE_UNAVAILABLE,
            ),
          );
          return;
        }

        performDirectUpload(stream);
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

    const deletePromises = fileRecord.chunks.map(async (chunk) => {
      if (chunk.telegramMessageId) {
        await this.telegram.deleteMessage(chunk.telegramMessageId, chunk.botId);
      }
    });
    await Promise.allSettled(deletePromises);

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
        await this.telegram.deleteMessage(chunk.telegramMessageId, chunk.botId);
      }
    }

    // Delete buffered files from temp storage before removing DB records
    if (fileRecord.tempStorageKey) {
      await this.tempStorage.delete(fileRecord.tempStorageKey).catch(() => {});
    }
    for (const chunk of latestChunks) {
      if (chunk.tempStorageKey) {
        await this.tempStorage.delete(chunk.tempStorageKey).catch(() => {});
      }
    }

    await this.prisma.fileRecord.delete({ where: { id: fileId } });

    this.logger.warn(
      `Upload aborted: "${fileRecord.filename}" (fileId: ${fileId}, cleaned up ${latestChunks.length} chunks)`,
    );
    return { success: true, deletedChunks: latestChunks.length };
  }

  async completeChunkedUpload(fileId: string, userId: string) {
    const fileRecord = await this.prisma.fileRecord.findFirst({
      where: { id: fileId, userId, deletedAt: null },
      include: { chunks: true },
    });
    if (!fileRecord) throw new NotFoundException('File record not found');
    if (fileRecord.status === 'complete') return fileRecord;

    // Ask Go for two counts: how many chunks have actually landed on Telegram
    // (completed, DB-backed) and how many the client has handed over in total
    // (received = completed + still-draining jobs Go holds). The async buffer's
    // whole purpose is that the client never waits for the slow Telegram leg, so
    // we must NOT block until everything drains — we decide based on `received`.
    let confirmRes: Awaited<
      ReturnType<typeof this.transferClient.flushAndConfirm>
    >;
    try {
      confirmRes = await this.transferClient.flushAndConfirm(fileId);
    } catch (err) {
      this.logger.error(
        `Failed to confirm chunks with Go for file ${fileId}`,
        err,
      );
      throw new HttpException(
        'Failed to synchronize with transfer service. Please try again.',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }

    // The client genuinely did not upload every chunk — this is a real client
    // error, not background draining. Reject so the client can retry the gap.
    if (!confirmRes.allReceived) {
      this.logger.warn(
        `Chunked upload incomplete for ${fileId}: received ${confirmRes.receivedChunks}/${confirmRes.totalChunks} chunks`,
      );
      throw new HttpException(
        `Upload incomplete. Expected ${confirmRes.totalChunks} chunks, got ${confirmRes.receivedChunks}.`,
        HttpStatus.BAD_REQUEST,
      );
    }

    const record = await this.prisma.fileRecord.findFirst({
      where: { id: fileId, userId, deletedAt: null },
      include: { chunks: true },
    });
    if (!record) {
      throw new NotFoundException('File record not found');
    }

    // Re-check after the metadata round-trip: a concurrent reportChunkResults
    // flip may have already completed the record.
    if (record.status === 'complete') return record;

    const landed = record.chunks.filter((c) => c.telegramFileId).length;

    // The client has handed over every chunk (all_received), so this upload
    // always succeeds from the client's perspective — we return OK regardless of
    // how many chunks have finished the slow Telegram leg:
    //
    //   all chunks landed → win the uploading/buffered → complete edge atomically
    //   and charge storage quota exactly once (count===1 means we won, not a
    //   racing chunk report). The file is now fully on Telegram and serveable.
    //
    //   still draining → park as "buffered" and return OK. Go persists every
    //   chunk row (status=buffered, temp key) at receive time, so the download
    //   path serves a draining chunked file part-by-part — buffered chunks from
    //   temp disk, completed chunks from Telegram. The final chunk report flips
    //   the record buffered → complete and charges quota then. "buffered" (not
    //   "uploading") is required: the download-token guard only accepts
    //   complete/buffered, so this is what makes download-while-draining reachable.
    if (landed >= record.totalChunks) {
      const flip = await this.prisma.fileRecord.updateMany({
        where: { id: fileId, status: { in: ['uploading', 'buffered'] } },
        data: { status: 'complete' },
      });
      if (flip.count === 1) {
        await this.prisma.user.update({
          where: { id: userId },
          data: { usedSpace: { increment: record.size } },
        });
      }
      this.logger.log(
        `Chunked upload completed: "${record.filename}" ` +
          `(fileId: ${fileId}, ${record.totalChunks} chunks, ${record.size} bytes)`,
      );
    } else {
      // Park as "buffered" so the file is downloadable while the remaining chunks
      // drain. Guard on status='uploading' so we never clobber a "complete" a
      // concurrent final-chunk report may have just won. Quota is charged on the
      // → complete flip (here or in reportChunkResults), never on this edge.
      await this.prisma.fileRecord.updateMany({
        where: { id: fileId, status: 'uploading' },
        data: { status: 'buffered' },
      });
      this.logger.log(
        `Chunked upload accepted (buffering): "${record.filename}" ` +
          `(fileId: ${fileId}, ${landed}/${record.totalChunks} chunks landed, ${record.size} bytes)`,
      );
    }

    return this.prisma.fileRecord.findFirstOrThrow({
      where: { id: fileId },
      include: { chunks: true },
    });
  }

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
