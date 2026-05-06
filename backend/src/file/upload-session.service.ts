import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  HttpException,
  HttpStatus,
  ConflictException,
} from '@nestjs/common';
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

    return new Promise<any>((resolve, reject) => {
      const bb = Busboy({ headers: req.headers });
      let fileProcessed = false;

      bb.on('file', (_name: string, stream: Readable) => {
        if (fileProcessed) {
          stream.resume();
          return;
        }
        fileProcessed = true;

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
          if (signal?.aborted) {
            reject(new Error('Upload cancelled'));
            return;
          }

          this.logger.log(
            `Starting chunk upload to Telegram: ${chunkIndex + 1}/${fileRecord.totalChunks} for file "${fileRecord.filename}" (${fileRecord.id}), ${rawBytes} bytes`,
          );

          this.prisma.fileChunk
            .create({
              data: {
                fileId,
                chunkIndex,
                size: rawBytes,
                telegramFileId: '',
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
                      const updated = await this.prisma.fileChunk.update({
                        where: { id: pendingChunk.id },
                        data: { telegramFileId, telegramMessageId, botId },
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
                        `Chunk uploaded: ${chunkIndex + 1}/${fileRecord.totalChunks} for file ${fileId} (${rawBytes} bytes)`,
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

    const uploadedChunks = fileRecord.chunks.length;
    if (uploadedChunks < fileRecord.totalChunks) {
      throw new BadRequestException(
        `Missing chunks: uploaded ${uploadedChunks}/${fileRecord.totalChunks}`,
      );
    }

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
