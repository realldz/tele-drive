import {
  Injectable,
  Logger,
  Inject,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { TelegramService } from '../telegram/telegram.service';
import { CryptoService } from '../crypto/crypto.service';
import { TEMP_STORAGE } from '../common/temp-storage';
import type { TempStorage } from '../common/temp-storage';
import { SettingsService } from '../settings/settings.service';
import { FileRecord, FileChunk } from '@prisma/client';

type DispatchCandidate =
  | {
      type: 'file';
      record: FileRecord;
      size: bigint;
      userId: string;
      createdAt: Date;
    }
  | {
      type: 'chunk';
      record: FileChunk & { file: FileRecord };
      size: number;
      userId: string;
      createdAt: Date;
    };

@Injectable()
export class UploadDispatcherService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(UploadDispatcherService.name);
  private processing = false;
  private shuttingDown = false;
  private currentDispatch: Promise<void> | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly telegram: TelegramService,
    private readonly cryptoService: CryptoService,
    @Inject(TEMP_STORAGE) private readonly tempStorage: TempStorage,
    private readonly settingsService: SettingsService,
  ) {}

  async onModuleInit(): Promise<void> {
    const fileCount = await this.prisma.fileRecord.count({
      where: { status: 'buffered' },
    });
    const chunkCount = await this.prisma.fileChunk.count({
      where: { status: 'buffered' },
    });

    if (fileCount > 0 || chunkCount > 0) {
      this.logger.log(
        `Found ${fileCount} buffered files and ${chunkCount} buffered chunks from previous session`,
      );
    }
    // Expire old buffered files (> 24h)
    await this.expireStaleBufferedFiles();
  }

  async onModuleDestroy(): Promise<void> {
    this.shuttingDown = true;
    this.logger.log(
      'Shutting down dispatcher — waiting for current dispatch to finish...',
    );
    if (this.currentDispatch) {
      await Promise.race([
        this.currentDispatch,
        new Promise((resolve) => setTimeout(resolve, 30_000)), // 30s timeout
      ]);
    }
    this.logger.log('Dispatcher shut down gracefully');
  }

  /**
   * Main dispatch loop — runs every 3 seconds.
   */
  @Cron('*/3 * * * * *')
  async handleCron(): Promise<void> {
    if (process.env.IS_TRANSFER_SERVICE === 'false') return;
    if (this.processing || this.shuttingDown) return;
    this.processing = true;

    this.currentDispatch = this.dispatch()
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        const stack = err instanceof Error ? err.stack : undefined;
        this.logger.error(`Dispatch error: ${msg}`, stack);
      })
      .finally(() => {
        this.processing = false;
        this.currentDispatch = null;
      });

    await this.currentDispatch;
  }

  private async dispatch(): Promise<void> {
    const candidates = await this.getCandidates();
    if (candidates.length === 0) return;

    // Group candidates by userId
    const byUser = new Map<string, typeof candidates>();
    for (const c of candidates) {
      const list = byUser.get(c.userId) || [];
      list.push(c);
      byUser.set(c.userId, list);
    }

    // Prioritize user with the most files
    let targetUserId = candidates[0].userId;
    let maxCount = 0;
    for (const [uid, list] of byUser.entries()) {
      if (list.length > maxCount) {
        maxCount = list.length;
        targetUserId = uid;
      }
    }

    const userCandidates = byUser.get(targetUserId)!;

    // Build the batch respecting MAX_BATCH_SIZE (10) and MAX_BATCH_TOTAL_SIZE (300MB)
    const maxBatchTotalSize = await this.settingsService.getCachedSetting(
      'MAX_BATCH_TOTAL_SIZE',
      314572800,
      (v) => parseInt(v, 10),
    );
    const maxBatchSize = await this.settingsService.getCachedSetting(
      'MAX_BATCH_SIZE',
      10,
      (v) => parseInt(v, 10),
    );

    const batch: typeof candidates = [];
    let currentBatchSize = 0n;

    for (const item of userCandidates) {
      const size = BigInt(item.size);
      if (currentBatchSize + size > BigInt(maxBatchTotalSize)) {
        if (batch.length === 0) {
          // Fallback: at least 1 item even if it exceeds the max total size limit
          batch.push(item);
        }
        break;
      }
      if (batch.length >= maxBatchSize) {
        break;
      }
      batch.push(item);
      currentBatchSize += size;
    }

    if (batch.length === 0) return;

    if (batch.length === 1) {
      await this.dispatchSingle(batch[0]);
    } else {
      await this.dispatchBatch(batch);
    }
  }

  private async getCandidates(): Promise<DispatchCandidate[]> {
    const bufferedFiles = await this.prisma.fileRecord.findMany({
      where: { status: 'buffered', isChunked: false },
      orderBy: { createdAt: 'asc' },
      take: 20,
    });

    const bufferedChunks = await this.prisma.fileChunk.findMany({
      where: {
        status: 'buffered',
        file: {
          status: 'buffered',
          isChunked: true,
        },
      },
      include: {
        file: true,
      },
      orderBy: { createdAt: 'asc' },
      take: 20,
    });

    const candidates: Array<
      | {
          type: 'file';
          record: FileRecord;
          size: bigint;
          userId: string;
          createdAt: Date;
        }
      | {
          type: 'chunk';
          record: FileChunk & { file: FileRecord };
          size: number;
          userId: string;
          createdAt: Date;
        }
    > = [];

    for (const f of bufferedFiles) {
      candidates.push({
        type: 'file',
        record: f,
        size: f.size,
        userId: f.userId,
        createdAt: f.createdAt,
      });
    }
    for (const c of bufferedChunks) {
      candidates.push({
        type: 'chunk',
        record: c,
        size: c.size,
        userId: c.file.userId,
        createdAt: c.createdAt,
      });
    }

    // Sort candidates by createdAt to preserve ordering
    candidates.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    return candidates;
  }

  private async dispatchSingle(item: DispatchCandidate): Promise<void> {
    if (item.type === 'file') {
      const record = item.record;
      try {
        const data = await this.readAndEncryptFile(record);
        const { fileId, messageId, botId } = await this.telegram.uploadFile(
          data.encryptedBuffer,
          record.id,
        );

        await this.prisma.$transaction(async (tx) => {
          await tx.fileRecord.update({
            where: { id: record.id },
            data: {
              status: 'complete',
              telegramFileId: fileId,
              telegramMessageId: messageId,
              botId,
              isEncrypted: true,
              encryptionAlgo: 'aes-256-ctr',
              encryptionIv: data.iv,
              encryptedKey: data.encryptedKey,
              tempStorageKey: null,
            },
          });

          await tx.user.update({
            where: { id: record.userId },
            data: { usedSpace: { increment: record.size } },
          });
        });

        await this.tempStorage.delete(record.tempStorageKey!).catch(() => {});
        this.logger.log(
          `Single file dispatched: "${record.filename}" (${record.size} bytes, bot: ${botId})`,
        );
      } catch (err: unknown) {
        await this.handleFileDispatchError(record, err);
      }
    } else {
      const chunk = item.record;
      try {
        const data = await this.readAndEncryptChunk(chunk, chunk.file);
        const { fileId, messageId, botId } = await this.telegram.uploadFile(
          data.encryptedBuffer,
          `${chunk.file.id}.part${String(chunk.chunkIndex).padStart(3, '0')}`,
        );

        await this.prisma.$transaction(async (tx) => {
          await tx.fileChunk.update({
            where: { id: chunk.id },
            data: {
              status: 'complete',
              telegramFileId: fileId,
              telegramMessageId: messageId,
              botId,
              encryptionIv: data.iv,
              tempStorageKey: null,
            },
          });

          // Check if parent FileRecord is fully completed
          const pendingChunksCount = await tx.fileChunk.count({
            where: { fileId: chunk.fileId, status: 'buffered' },
          });

          if (pendingChunksCount === 0) {
            await tx.fileRecord.update({
              where: { id: chunk.fileId },
              data: { status: 'complete' },
            });

            await tx.user.update({
              where: { id: chunk.file.userId },
              data: { usedSpace: { increment: chunk.file.size } },
            });

            this.logger.log(
              `Chunked file fully complete: "${chunk.file.filename}" (${chunk.file.size} bytes)`,
            );
          }
        });

        await this.tempStorage.delete(chunk.tempStorageKey!).catch(() => {});
        this.logger.log(
          `Single chunk dispatched: index ${chunk.chunkIndex} for file ${chunk.fileId} (bot: ${botId})`,
        );
      } catch (err: unknown) {
        await this.handleChunkDispatchError(chunk, err);
      }
    }
  }

  private async dispatchBatch(items: DispatchCandidate[]): Promise<void> {
    const prepared = await Promise.all(
      items.map(async (item) => {
        if (item.type === 'file') {
          const record = item.record;
          const data = await this.readAndEncryptFile(record);
          return {
            item,
            encryptedBuffer: data.encryptedBuffer,
            filename: record.id,
            iv: data.iv,
            encryptedKey: data.encryptedKey,
          };
        } else {
          const chunk = item.record;
          const data = await this.readAndEncryptChunk(chunk, chunk.file);
          return {
            item,
            encryptedBuffer: data.encryptedBuffer,
            filename: `${chunk.file.id}.part${String(chunk.chunkIndex).padStart(3, '0')}`,
            iv: data.iv,
            encryptedKey: undefined,
          };
        }
      }),
    );

    const { botClient, botId } = await this.telegram.acquireUploadSlot();

    const mediaGroup = prepared.map((p) => ({
      type: 'document' as const,
      media: { source: p.encryptedBuffer, filename: p.filename },
    }));

    try {
      const messages = await botClient.sendMediaGroup(
        this.telegram.telegramChatId,
        mediaGroup,
      );

      await this.prisma.$transaction(async (tx) => {
        for (let i = 0; i < messages.length; i++) {
          const msg = messages[i];
          const prep = prepared[i];
          const doc = 'document' in msg ? msg.document : null;
          if (!doc) {
            throw new Error(
              `Media group element at index ${i} did not return a valid document`,
            );
          }

          if (prep.item.type === 'file') {
            const record = prep.item.record;
            await tx.fileRecord.update({
              where: { id: record.id },
              data: {
                status: 'complete',
                telegramFileId: doc.file_id,
                telegramMessageId: msg.message_id,
                botId,
                isEncrypted: true,
                encryptionAlgo: 'aes-256-ctr',
                encryptionIv: prep.iv,
                encryptedKey: prep.encryptedKey,
                tempStorageKey: null,
              },
            });

            await tx.user.update({
              where: { id: record.userId },
              data: { usedSpace: { increment: record.size } },
            });
          } else {
            const chunk = prep.item.record as FileChunk & { file: FileRecord };
            await tx.fileChunk.update({
              where: { id: chunk.id },
              data: {
                status: 'complete',
                telegramFileId: doc.file_id,
                telegramMessageId: msg.message_id,
                botId,
                encryptionIv: prep.iv,
                tempStorageKey: null,
              },
            });

            // Check if parent FileRecord is fully completed
            const pendingChunksCount = await tx.fileChunk.count({
              where: { fileId: chunk.fileId, status: 'buffered' },
            });

            if (pendingChunksCount === 0) {
              await tx.fileRecord.update({
                where: { id: chunk.fileId },
                data: { status: 'complete' },
              });

              await tx.user.update({
                where: { id: chunk.file.userId },
                data: { usedSpace: { increment: chunk.file.size } },
              });

              this.logger.log(
                `Chunked file fully complete: "${chunk.file.filename}" (${chunk.file.size} bytes)`,
              );
            }
          }
        }
      });

      await Promise.allSettled(
        prepared.map((prep) =>
          this.tempStorage.delete(prep.item.record.tempStorageKey!),
        ),
      );

      this.logger.log(
        `Batch dispatched: ${messages.length} files/chunks via sendMediaGroup (bot: ${botId})`,
      );
    } catch (err: unknown) {
      this.logger.warn(
        `sendMediaGroup failed for ${items.length} items, falling back to individual: ${err instanceof Error ? err.message : String(err)}`,
      );
      for (const item of items) {
        await this.dispatchSingle(item);
      }
    }
  }

  private async readAndEncryptFile(record: FileRecord) {
    const stream = await this.tempStorage.read(record.tempStorageKey!);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(chunk);
    const plainBuffer = Buffer.concat(chunks);

    const dek = this.cryptoService.generateFileKey();
    const iv = this.cryptoService.generateIv();
    const encryptedKey = this.cryptoService.encryptKey(dek);
    const cipher = this.cryptoService.createEncryptStream(dek, iv);
    const encryptedBuffer = Buffer.concat([
      cipher.update(plainBuffer),
      cipher.final(),
    ]);

    return {
      encryptedBuffer,
      encryptedKey,
      iv: iv.toString('hex'),
    };
  }

  private async readAndEncryptChunk(chunk: FileChunk, fileRecord: FileRecord) {
    const stream = await this.tempStorage.read(chunk.tempStorageKey!);
    const chunks: Buffer[] = [];
    for await (const c of stream) chunks.push(c);
    const plainBuffer = Buffer.concat(chunks);

    if (!fileRecord.isEncrypted || !fileRecord.encryptedKey) {
      return {
        encryptedBuffer: plainBuffer,
        iv: null,
      };
    }

    const dek = this.cryptoService.decryptKey(fileRecord.encryptedKey);
    let ivBuffer: Buffer;
    if (chunk.encryptionIv) {
      ivBuffer = Buffer.from(chunk.encryptionIv, 'hex');
    } else {
      ivBuffer = this.cryptoService.generateIv();
    }

    const cipher = this.cryptoService.createEncryptStream(dek, ivBuffer);
    const encryptedBuffer = Buffer.concat([
      cipher.update(plainBuffer),
      cipher.final(),
    ]);

    return {
      encryptedBuffer,
      iv: ivBuffer.toString('hex'),
    };
  }

  private async handleFileDispatchError(record: FileRecord, err: unknown) {
    const retries = record.bufferRetries + 1;
    const maxRetries = await this.settingsService.getCachedSetting(
      'BUFFER_MAX_RETRIES',
      3,
      (v) => parseInt(v, 10),
    );
    if (retries >= maxRetries) {
      await this.prisma.fileRecord.update({
        where: { id: record.id },
        data: { status: 'buffer_failed', bufferRetries: retries },
      });
      this.logger.error(
        `File dispatch permanently failed after ${retries} retries: ${record.id}`,
        err,
      );
    } else {
      await this.prisma.fileRecord.update({
        where: { id: record.id },
        data: { bufferRetries: retries },
      });
      this.logger.warn(
        `File dispatch retry ${retries}/${maxRetries}: ${record.id}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private async handleChunkDispatchError(
    chunk: FileChunk & { file: FileRecord },
    err: unknown,
  ) {
    const parent = chunk.file;
    const retries = parent.bufferRetries + 1;
    const maxRetries = await this.settingsService.getCachedSetting(
      'BUFFER_MAX_RETRIES',
      3,
      (v) => parseInt(v, 10),
    );
    if (retries >= maxRetries) {
      await this.prisma.fileRecord.update({
        where: { id: parent.id },
        data: { status: 'buffer_failed', bufferRetries: retries },
      });
      this.logger.error(
        `Chunked file dispatch permanently failed after ${retries} retries: chunk index ${chunk.chunkIndex} of file ${parent.id}`,
        err,
      );
    } else {
      await this.prisma.fileRecord.update({
        where: { id: parent.id },
        data: { bufferRetries: retries },
      });
      this.logger.warn(
        `Chunked file dispatch retry ${retries}/${maxRetries}: chunk index ${chunk.chunkIndex} of file ${parent.id}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private async expireStaleBufferedFiles(): Promise<void> {
    const bufferTtlHours = await this.settingsService.getCachedSetting(
      'BUFFER_TTL_HOURS',
      24,
      (v) => parseInt(v, 10),
    );
    const cutoff = new Date(Date.now() - bufferTtlHours * 60 * 60 * 1000);
    const expired = await this.prisma.fileRecord.updateMany({
      where: { status: 'buffered', createdAt: { lt: cutoff } },
      data: { status: 'buffer_failed' },
    });
    if (expired.count > 0) {
      this.logger.warn(
        `Expired ${expired.count} stale buffered files (>${bufferTtlHours}h)`,
      );
    }
  }
}
