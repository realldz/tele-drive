import { Processor, WorkerHost, InjectQueue } from '@nestjs/bullmq';
import {
  Injectable,
  Logger,
  Inject,
  OnModuleInit,
  OnModuleDestroy,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { Job, Queue } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import { TelegramService } from '../telegram/telegram.service';
import { CryptoService } from '../crypto/crypto.service';
import { TEMP_STORAGE } from '../common/temp-storage';
import type { TempStorage } from '../common/temp-storage';
import { SettingsService } from '../settings/settings.service';
import { UploadJobData, UploadFileJobData, UploadChunkJobData } from '../queue';
import { FileRecord, FileChunk } from '@prisma/client';
import { GrpcTransferClient } from '../grpc/grpc-transfer.client';

const dispatchOwnerIsGo = (): boolean =>
  (process.env.UPLOAD_DISPATCH_OWNER || 'go') === 'go';

const getConcurrency = () => {
  const envVal = process.env.DISPATCH_CONCURRENCY;
  if (envVal !== undefined) {
    const parsed = parseInt(envVal, 10);
    if (parsed > 0) return parsed;
  }
  const extra = (process.env.TELEGRAM_UPLOAD_BOT_TOKENS || '')
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
  return 1 + extra.length;
};

@Processor('upload-dispatch', {
  concurrency: getConcurrency(),
})
@Injectable()
export class UploadQueueProcessor
  extends WorkerHost
  implements OnModuleInit, OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(UploadQueueProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly telegram: TelegramService,
    private readonly cryptoService: CryptoService,
    @Inject(TEMP_STORAGE) private readonly tempStorage: TempStorage,
    private readonly settingsService: SettingsService,
    @InjectQueue('upload-dispatch') private readonly uploadQueue: Queue,
    private readonly transferClient: GrpcTransferClient,
  ) {
    super();
  }

  async onModuleInit(): Promise<void> {
    if (process.env.IS_TRANSFER_SERVICE === 'false' && !dispatchOwnerIsGo()) {
      if (this.worker) this.worker.pause();
      return;
    }

    // Run startup recovery
    try {
      this.logger.log('Starting upload queue startup recovery...');
      const maxRetries = await this.settingsService.getCachedSetting(
        'BUFFER_MAX_RETRIES',
        3,
        (v) => parseInt(v, 10),
      );

      const bufferedFiles = await this.prisma.fileRecord.findMany({
        where: { status: 'buffered', isChunked: false },
      });

      const bufferedChunks = await this.prisma.fileChunk.findMany({
        where: { status: 'buffered' },
        include: { file: true },
      });

      let reEnqueuedCount = 0;

      // When Go owns dispatch, re-hand-off stuck buffered items to Go via gRPC
      if (dispatchOwnerIsGo()) {
        for (const file of bufferedFiles) {
          if (!file.tempStorageKey) continue;
          try {
            const res = await this.transferClient.enqueueBufferedUpload({
              fileId: file.id,
              tempStorageKey: file.tempStorageKey,
              userId: file.userId,
              isChunk: false,
              chunkIndex: 0,
              size: Number(file.size),
            });
            if (res.accepted) reEnqueuedCount++;
          } catch (err) {
            this.logger.error(
              `Failed to re-hand-off buffered file ${file.id} to Go: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }

        for (const chunk of bufferedChunks) {
          if (!chunk.tempStorageKey) continue;
          try {
            const res = await this.transferClient.enqueueBufferedUpload({
              fileId: chunk.fileId,
              tempStorageKey: chunk.tempStorageKey,
              userId: chunk.file.userId,
              isChunk: true,
              chunkIndex: chunk.chunkIndex,
              size: Number(chunk.size),
            });
            if (res.accepted) reEnqueuedCount++;
          } catch (err) {
            this.logger.error(
              `Failed to re-hand-off buffered chunk ${chunk.id} to Go: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }

        if (this.worker) await this.worker.pause();

        if (reEnqueuedCount > 0) {
          this.logger.log(
            `Startup recovery (Go dispatch): re-handed-off ${reEnqueuedCount} buffered items to transfer service.`,
          );
        } else {
          this.logger.log(
            'Startup recovery (Go dispatch): no buffered items to recover.',
          );
        }
        return;
      }

      for (const file of bufferedFiles) {
        if (!file.tempStorageKey) continue;
        try {
          await this.uploadQueue.add(
            'dispatch-file',
            {
              type: 'file',
              recordId: file.id,
              tempStorageKey: file.tempStorageKey,
              userId: file.userId,
            },
            {
              jobId: `file-${file.id}`,
              attempts: maxRetries,
              backoff: { type: 'exponential', delay: 5000 },
              removeOnComplete: true,
              removeOnFail: 100,
            },
          );
          reEnqueuedCount++;
        } catch (err) {
          this.logger.error(
            `Failed to re-enqueue buffered file ${file.id}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }

      for (const chunk of bufferedChunks) {
        if (!chunk.tempStorageKey) continue;
        try {
          await this.uploadQueue.add(
            'dispatch-chunk',
            {
              type: 'chunk',
              chunkId: chunk.id,
              fileRecordId: chunk.fileId,
              chunkIndex: chunk.chunkIndex,
              tempStorageKey: chunk.tempStorageKey,
              userId: chunk.file.userId,
            },
            {
              jobId: `chunk-${chunk.id}`,
              attempts: maxRetries,
              backoff: { type: 'exponential', delay: 5000 },
              removeOnComplete: true,
              removeOnFail: 100,
            },
          );
          reEnqueuedCount++;
        } catch (err) {
          this.logger.error(
            `Failed to re-enqueue buffered chunk ${chunk.id}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }

      if (reEnqueuedCount > 0) {
        this.logger.log(
          `Startup recovery: Re-enqueued ${reEnqueuedCount} jobs.`,
        );
      } else {
        this.logger.log(
          'Startup recovery: No buffered items found to recover.',
        );
      }
    } catch (err) {
      this.logger.error(
        `Error during startup recovery: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  async onApplicationBootstrap(): Promise<void> {
    if (process.env.IS_TRANSFER_SERVICE === 'false' || dispatchOwnerIsGo()) {
      this.logger.log(
        dispatchOwnerIsGo()
          ? 'UPLOAD_DISPATCH_OWNER=go. Upload dispatch handled by Go transfer service; pausing NestJS worker.'
          : 'IS_TRANSFER_SERVICE is false. Pausing upload queue worker.',
      );
      if (this.worker) {
        await this.worker.pause();
      }
    }
  }

  async onModuleDestroy(): Promise<void> {
    this.logger.log('Shutting down upload queue processor...');
    if (this.worker) {
      await this.worker.close();
    }
  }

  async process(job: Job<UploadJobData>): Promise<void> {
    if (dispatchOwnerIsGo()) {
      // Dispatch is owned by the Go transfer service. This worker is disabled
      // (paused at bootstrap); ignore any residual jobs without processing.
      this.logger.warn(
        `Ignoring upload-dispatch job ${job.id}: dispatch owned by Go transfer service.`,
      );
      return;
    }
    try {
      if (job.data.type === 'file') {
        await this.processFileJob(job as Job<UploadFileJobData>);
      } else if (job.data.type === 'chunk') {
        await this.processChunkJob(job as Job<UploadChunkJobData>);
      }
    } catch (err) {
      await this.handleJobFailure(job, err);
      throw err; // throw to trigger BullMQ retry/fail flow
    }
  }

  private async processFileJob(job: Job<UploadFileJobData>): Promise<void> {
    const { recordId, tempStorageKey, userId } = job.data;

    const record = await this.prisma.fileRecord.findUnique({
      where: { id: recordId },
    });

    if (!record) {
      this.logger.warn(`File record ${recordId} not found. Skipping.`);
      return;
    }

    if (record.status === 'complete') {
      this.logger.log(
        `File record ${recordId} is already completed. Skipping.`,
      );
      return;
    }

    if (record.status !== 'buffered') {
      this.logger.warn(
        `File record ${recordId} status is "${record.status}", expected "buffered". Skipping.`,
      );
      return;
    }

    // Read and encrypt
    const encryptionData = await this.readAndEncryptFile(record);

    // Upload to Telegram
    const { fileId, messageId, botId } = await this.telegram.uploadFile(
      encryptionData.encryptedBuffer,
      record.id,
    );

    // DB updates inside transaction
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
          encryptionIv: encryptionData.iv,
          encryptedKey: encryptionData.encryptedKey,
          tempStorageKey: null,
        },
      });

      await tx.user.update({
        where: { id: userId },
        data: { usedSpace: { increment: record.size } },
      });
    });

    // Delete temp file
    await this.tempStorage.delete(tempStorageKey).catch(() => {});

    this.logger.log(
      `File dispatched successfully: "${record.filename}" (${record.size} bytes, bot: ${botId})`,
    );
  }

  private async processChunkJob(job: Job<UploadChunkJobData>): Promise<void> {
    const { chunkId, fileRecordId, chunkIndex, tempStorageKey, userId } =
      job.data;

    const chunk = await this.prisma.fileChunk.findUnique({
      where: { id: chunkId },
      include: { file: true },
    });

    if (!chunk) {
      this.logger.warn(`Chunk record ${chunkId} not found. Skipping.`);
      return;
    }

    if (chunk.status === 'complete') {
      this.logger.log(`Chunk ${chunkId} is already completed. Skipping.`);
      return;
    }

    if (chunk.status !== 'buffered') {
      this.logger.warn(
        `Chunk ${chunkId} status is "${chunk.status}", expected "buffered". Skipping.`,
      );
      return;
    }

    // Read and encrypt chunk
    const encryptionData = await this.readAndEncryptChunk(chunk, chunk.file);

    // Upload to Telegram
    const partFilename = `${chunk.file.id}.part${String(chunkIndex).padStart(3, '0')}`;
    const { fileId, messageId, botId } = await this.telegram.uploadFile(
      encryptionData.encryptedBuffer,
      partFilename,
    );

    // DB updates inside transaction
    await this.prisma.$transaction(async (tx) => {
      await tx.fileChunk.update({
        where: { id: chunk.id },
        data: {
          status: 'complete',
          telegramFileId: fileId,
          telegramMessageId: messageId,
          botId,
          encryptionIv: encryptionData.iv,
          tempStorageKey: null,
        },
      });

      const pendingChunksCount = await tx.fileChunk.count({
        where: { fileId: fileRecordId, status: 'buffered' },
      });

      if (pendingChunksCount === 0) {
        await tx.fileRecord.update({
          where: { id: fileRecordId },
          data: { status: 'complete' },
        });

        await tx.user.update({
          where: { id: userId },
          data: { usedSpace: { increment: chunk.file.size } },
        });

        this.logger.log(
          `Chunked file fully complete: "${chunk.file.filename}" (${chunk.file.size} bytes)`,
        );
      }
    });

    // Delete temp file
    await this.tempStorage.delete(tempStorageKey).catch(() => {});

    this.logger.log(
      `Chunk dispatched successfully: index ${chunkIndex} for file ${fileRecordId} (bot: ${botId})`,
    );
  }

  private async handleJobFailure(job: Job<UploadJobData>, err: any) {
    const isFile = job.data.type === 'file';
    const recordId =
      job.data.type === 'file' ? job.data.recordId : job.data.fileRecordId;
    const maxRetries = job.opts.attempts ?? 3;
    const isFinalAttempt = job.attemptsMade >= maxRetries;

    try {
      if (isFinalAttempt) {
        await this.prisma.fileRecord.update({
          where: { id: recordId },
          data: {
            status: 'buffer_failed',
            bufferRetries: job.attemptsMade,
          },
        });
        this.logger.error(
          `${isFile ? 'File' : 'Chunked file'} upload permanently failed after ${job.attemptsMade} attempts: ${recordId}`,
          err,
        );
      } else {
        await this.prisma.fileRecord.update({
          where: { id: recordId },
          data: {
            bufferRetries: job.attemptsMade,
          },
        });
        this.logger.warn(
          `${isFile ? 'File' : 'Chunked file'} upload attempt ${job.attemptsMade}/${maxRetries} failed for ${recordId}, will retry: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    } catch (dbErr) {
      this.logger.error(
        `Failed to update failure status in DB for ${recordId}: ${dbErr instanceof Error ? dbErr.message : String(dbErr)}`,
      );
    }
  }

  private async readAndEncryptFile(record: FileRecord) {
    if (!record.tempStorageKey) {
      throw new Error(`tempStorageKey is missing for file record ${record.id}`);
    }
    const stream = await this.tempStorage.read(record.tempStorageKey);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(chunk as Buffer);
    }
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
    if (!chunk.tempStorageKey) {
      throw new Error(`tempStorageKey is missing for chunk ${chunk.id}`);
    }
    const stream = await this.tempStorage.read(chunk.tempStorageKey);
    const chunks: Buffer[] = [];
    for await (const c of stream) {
      chunks.push(c as Buffer);
    }
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
}
