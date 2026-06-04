import {
  Injectable,
  Logger,
  Inject,
  HttpException,
  HttpStatus,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { TEMP_STORAGE } from '../common/temp-storage';
import type { TempStorage } from '../common/temp-storage';
import {
  NameConflictService,
  ConflictAction,
} from '../common/name-conflict.service';
import { SettingsService } from '../settings/settings.service';
import { FileRecord, FileChunk } from '@prisma/client';
import { CryptoService } from '../crypto/crypto.service';
import * as crypto from 'crypto';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';

@Injectable()
export class UploadBufferService {
  private readonly logger = new Logger(UploadBufferService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(TEMP_STORAGE) private readonly tempStorage: TempStorage,
    private readonly nameConflictService: NameConflictService,
    private readonly cryptoService: CryptoService,
    private readonly settingsService: SettingsService,
    @InjectQueue('upload-dispatch') private readonly uploadQueue: Queue,
  ) {}

  async shouldBuffer(size: number): Promise<boolean> {
    const maxBufferFileSize = await this.settingsService.getCachedSetting(
      'MAX_BUFFER_FILE_SIZE',
      52428800,
      (v) => parseInt(v, 10),
    );
    if (size > maxBufferFileSize) {
      return false;
    }
    // Check backpressure threshold
    try {
      const usedBytes = await this.tempStorage.getUsedBytes();
      const maxBufferDiskMb = await this.settingsService.getCachedSetting(
        'MAX_BUFFER_DISK_MB',
        2048,
        (v) => parseInt(v, 10),
      );
      const maxBytes = BigInt(maxBufferDiskMb) * 1024n * 1024n;
      const thresholdBytes = BigInt(Math.floor(Number(maxBytes) * 0.8));
      if (usedBytes >= thresholdBytes) {
        this.logger.warn(
          `Temp storage usage (${usedBytes} bytes) exceeds backpressure threshold (${thresholdBytes} bytes). Falling back to direct upload.`,
        );
        return false;
      }
    } catch (err) {
      this.logger.error('Failed to check temp storage capacity', err);
      // Fallback to direct upload on storage error just in case
      return false;
    }
    return true;
  }

  async acceptFile(params: {
    buffer: Buffer;
    filename: string;
    mimeType: string;
    size: number;
    userId: string;
    folderId?: string;
    conflictAction?: ConflictAction;
  }): Promise<FileRecord> {
    if (params.size <= 0) {
      throw new HttpException(
        'Empty files are not supported',
        HttpStatus.BAD_REQUEST,
      );
    }

    // 1. Check user quota
    await this.checkQuota(params.userId, params.size);

    // 2. Resolve conflict name
    const targetFilename = await this.resolveFilename(params);

    // 3. Check buffer capacity again
    const capacityOk = await this.shouldBuffer(params.size);
    if (!capacityOk) {
      throw new HttpException(
        'Temp storage capacity exceeded or file too large for buffer',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }

    const storageKey = `buf/${crypto.randomUUID()}.tmp`;

    // Write file to temp storage first
    try {
      await this.tempStorage.write(storageKey, params.buffer);
    } catch (err) {
      this.logger.error(
        `Failed to write to temp storage for ${targetFilename}`,
        err,
      );
      throw new HttpException(
        'Failed to buffer file to disk',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }

    try {
      // Create DB Record with status: 'buffered'
      const record = await this.prisma.fileRecord.create({
        data: {
          filename: targetFilename,
          size: params.size,
          mimeType: params.mimeType,
          status: 'buffered',
          tempStorageKey: storageKey,
          isChunked: false,
          totalChunks: 1,
          folderId: params.folderId || null,
          userId: params.userId,
          // encryption fields left null — set by dispatcher
        },
      });

      this.logger.log(
        `File buffered: "${targetFilename}" (${params.size} bytes, userId: ${params.userId}, key: ${storageKey})`,
      );

      // Enqueue upload job
      const maxRetries = await this.settingsService.getCachedSetting(
        'BUFFER_MAX_RETRIES',
        3,
        (v) => parseInt(v, 10),
      );

      await this.uploadQueue
        .add(
          'dispatch-file',
          {
            type: 'file',
            recordId: record.id,
            tempStorageKey: storageKey,
            userId: params.userId,
          },
          {
            jobId: `file-${record.id}`,
            attempts: maxRetries,
            backoff: { type: 'exponential', delay: 5000 },
            removeOnComplete: true,
            removeOnFail: 100,
          },
        )
        .catch((err) => {
          this.logger.error(
            `Failed to enqueue job for file ${record.id}: ${err}`,
          );
        });

      return record;
    } catch (err) {
      // Clean up write on failure
      await this.tempStorage.delete(storageKey).catch(() => {});
      this.logger.error(
        `Failed to create database record for buffered file ${targetFilename}`,
        err,
      );
      throw err;
    }
  }

  async acceptChunk(params: {
    buffer: Buffer;
    size: number;
    fileRecordId: string;
    chunkIndex: number;
    userId: string;
  }): Promise<FileChunk> {
    // Check capacity
    const capacityOk = await this.shouldBuffer(params.size);
    if (!capacityOk) {
      throw new HttpException(
        'Temp storage capacity exceeded or chunk too large for buffer',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }

    const storageKey = `chunk/${params.fileRecordId}/${params.chunkIndex}.tmp`;

    // Write chunk to temp storage
    try {
      await this.tempStorage.write(storageKey, params.buffer);
    } catch (err) {
      this.logger.error(
        `Failed to write chunk to temp storage for file ${params.fileRecordId} index ${params.chunkIndex}`,
        err,
      );
      throw new HttpException(
        'Failed to buffer chunk to disk',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }

    try {
      const fileRecord = await this.prisma.fileRecord.findUnique({
        where: { id: params.fileRecordId },
        select: { isEncrypted: true, encryptedKey: true },
      });

      let encryptionIv: string | null = null;
      if (fileRecord?.isEncrypted && fileRecord.encryptedKey) {
        encryptionIv = this.cryptoService.generateIv().toString('hex');
      }

      // Create FileChunk record
      const chunk = await this.prisma.fileChunk.create({
        data: {
          fileId: params.fileRecordId,
          chunkIndex: params.chunkIndex,
          size: params.size,
          telegramFileId: null,
          tempStorageKey: storageKey,
          status: 'buffered',
          encryptionIv,
        },
      });

      // Enqueue upload job
      const maxRetries = await this.settingsService.getCachedSetting(
        'BUFFER_MAX_RETRIES',
        3,
        (v) => parseInt(v, 10),
      );

      await this.uploadQueue
        .add(
          'dispatch-chunk',
          {
            type: 'chunk',
            chunkId: chunk.id,
            fileRecordId: params.fileRecordId,
            chunkIndex: params.chunkIndex,
            tempStorageKey: storageKey,
            userId: params.userId,
          },
          {
            jobId: `chunk-${chunk.id}`,
            attempts: maxRetries,
            backoff: { type: 'exponential', delay: 5000 },
            removeOnComplete: true,
            removeOnFail: 100,
          },
        )
        .catch((err) => {
          this.logger.error(
            `Failed to enqueue job for chunk ${chunk.id}: ${err}`,
          );
        });

      return chunk;
    } catch (err) {
      await this.tempStorage.delete(storageKey).catch(() => {});
      this.logger.error(
        `Failed to create FileChunk record for index ${params.chunkIndex}`,
        err,
      );
      throw err;
    }
  }

  private async checkQuota(userId: string, fileSize: number): Promise<void> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { usedSpace: true, quota: true },
    });
    if (!user) throw new NotFoundException('User not found');

    const size = BigInt(fileSize);
    if (user.usedSpace + size > user.quota) {
      const usedMB = Number(user.usedSpace) / (1024 * 1024);
      const quotaMB = Number(user.quota) / (1024 * 1024);
      throw new HttpException(
        `Storage quota exceeded. Used: ${usedMB.toFixed(1)}MB, Quota: ${quotaMB.toFixed(1)}MB`,
        HttpStatus.BAD_REQUEST,
      );
    }
  }

  private async resolveFilename(params: {
    filename: string;
    userId: string;
    folderId?: string;
    conflictAction?: ConflictAction;
  }): Promise<string> {
    const conflict = await this.nameConflictService.checkFileConflict(
      params.folderId || null,
      params.filename,
      params.userId,
    );

    if (conflict) {
      if (!params.conflictAction || params.conflictAction === 'skip') {
        throw new ConflictException({
          message:
            'A file or folder with this name already exists in the destination folder',
          type: 'file' as const,
          id: conflict.id,
          name: conflict.filename,
          suggestedName: this.nameConflictService.generateUniqueName(
            params.filename,
            await this.nameConflictService.getExistingNames(
              params.folderId || null,
              params.userId,
            ),
          ),
        });
      }

      if (params.conflictAction === 'overwrite') {
        await this.prisma.fileRecord.update({
          where: { id: conflict.id },
          data: { deletedAt: new Date() },
        });
        this.logger.log(
          `File overwritten: "${conflict.filename}" (id: ${conflict.id}) soft-deleted`,
        );
      }

      if (params.conflictAction === 'rename') {
        const existingNames = await this.nameConflictService.getExistingNames(
          params.folderId || null,
          params.userId,
        );
        return this.nameConflictService.generateUniqueName(
          params.filename,
          existingNames,
        );
      }
    }

    return params.filename;
  }
}
