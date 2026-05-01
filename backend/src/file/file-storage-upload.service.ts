import {
  Injectable,
  Logger,
  NotFoundException,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { TelegramService } from '../telegram/telegram.service';
import { Readable } from 'stream';
import { CryptoService } from '../crypto/crypto.service';
import { FileLifecycleService } from './file-lifecycle.service';

@Injectable()
export class FileStorageUploadService {
  private readonly logger = new Logger(FileStorageUploadService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly telegram: TelegramService,
    private readonly cryptoService: CryptoService,
    private readonly fileLifecycleService: FileLifecycleService,
  ) {}

  async checkQuota(userId: string, fileSize: number | bigint): Promise<void> {
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

    const cipher = this.cryptoService.createEncryptStream(dek, iv);
    const encryptedBuffer = Buffer.concat([
      cipher.update(buffer),
      cipher.final(),
    ]);

    if (existingFileId) {
      const {
        fileId: telegramFileId,
        messageId: telegramMessageId,
        botId,
      } = await this.telegram.uploadFile(
        encryptedBuffer,
        existingFileId,
        signal,
      );

      if (oldRecord) {
        await this.fileLifecycleService.purgeFilesFromTelegram([oldRecord]);
      }

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
    }

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

  async uploadFromStream(params: {
    stream: Readable;
    filename: string;
    mimeType: string;
    size: number;
    userId: string;
    folderId?: string | null;
    existingFileId?: string;
    signal?: AbortSignal;
    etag?: string;
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
      etag,
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
        await this.fileLifecycleService.purgeFilesFromTelegram([oldRecord]);
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
            ...(etag ? { etag } : {}),
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
    }

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
        ...(etag ? { etag } : {}),
        folderId: folderId || null,
        userId,
      },
    });

    try {
      const {
        fileId: telegramFileId,
        messageId: telegramMessageId,
        botId,
      } = await this.telegram.uploadStream(encryptedStream, record.id, signal);

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

  async updateObjectEtag(fileId: string, etag: string) {
    return this.prisma.fileRecord.update({
      where: { id: fileId },
      data: { etag },
    });
  }
}
