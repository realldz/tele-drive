import { Controller, Logger } from '@nestjs/common';
import { GrpcMethod } from '@nestjs/microservices';
import { PrismaService } from '../prisma/prisma.service';
import { FolderService } from '../folder/folder.service';
import { randomUUID } from 'crypto';

@Controller()
export class GrpcCoreController {
  private readonly logger = new Logger(GrpcCoreController.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly folderService: FolderService,
  ) {}

  @GrpcMethod('CoreService', 'Ping')
  ping() {
    return { timestamp: Date.now() };
  }

  @GrpcMethod('CoreService', 'ReportChunkResults')
  async reportChunkResults(data: {
    results: Array<{
      fileId: string;
      chunkIndex: number;
      telegramFileId: string;
      telegramMessageId: number;
      botId: number;
      encryptionIv: string;
      size: number;
      etag: string;
      chunkId: string;
    }>;
  }) {
    if (!data.results || data.results.length === 0) {
      return { accepted: 0 };
    }

    this.logger.debug(`Received ${data.results.length} chunk results from Go`);

    let accepted = 0;
    for (const chunk of data.results) {
      try {
        await this.prisma.fileChunk.upsert({
          where: {
            fileId_chunkIndex: {
              fileId: chunk.fileId,
              chunkIndex: chunk.chunkIndex,
            },
          },
          update: {
            telegramFileId: chunk.telegramFileId,
            telegramMessageId: chunk.telegramMessageId,
            botId: BigInt(chunk.botId),
            encryptionIv: chunk.encryptionIv,
            etag: chunk.etag,
            size: chunk.size,
            status: 'complete',
          },
          create: {
            id: chunk.chunkId || randomUUID(),
            fileId: chunk.fileId,
            chunkIndex: chunk.chunkIndex,
            telegramFileId: chunk.telegramFileId,
            telegramMessageId: chunk.telegramMessageId,
            botId: BigInt(chunk.botId),
            encryptionIv: chunk.encryptionIv,
            etag: chunk.etag,
            size: chunk.size,
            status: 'complete',
          },
        });
        accepted++;
      } catch (err) {
        this.logger.error(
          `Failed to upsert chunk ${chunk.chunkIndex} for file ${chunk.fileId}`,
          err,
        );
      }
    }

    return { accepted };
  }

  @GrpcMethod('CoreService', 'GetFileMetadata')
  async getFileMetadata(data: { fileId: string }) {
    const isUuid =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        data.fileId,
      );

    const record = await this.prisma.fileRecord.findFirst({
      where: isUuid ? { id: data.fileId } : { shareToken: data.fileId },
      include: { chunks: { orderBy: { chunkIndex: 'asc' } } },
    });

    if (!record) {
      throw new Error(`File not found: ${data.fileId}`);
    }

    return {
      id: record.id,
      userId: record.userId,
      size: Number(record.size),
      mimeType: record.mimeType,
      filename: record.filename,

      isEncrypted: record.isEncrypted,
      encryptionAlgo: record.encryptionAlgo || '',
      encryptionIv: record.encryptionIv || '',
      encryptedKey: record.encryptedKey || '',

      botId: Number(record.botId),
      isChunked: record.isChunked,
      telegramFileId: record.telegramFileId || '',
      telegramMessageId: record.telegramMessageId || 0,
      totalChunks: record.totalChunks,

      status: record.status,
      visibility: record.visibility,

      chunks: record.chunks.map((c) => ({
        chunkIndex: c.chunkIndex,
        size: c.size,
        telegramFileId: c.telegramFileId || '',
        telegramMessageId: c.telegramMessageId || 0,
        botId: Number(c.botId),
        encryptionIv: c.encryptionIv || '',
        etag: c.etag || '',
      })),
    };
  }

  @GrpcMethod('CoreService', 'VerifyFolderShare')
  async verifyFolderShare(data: { shareToken: string; fileId: string }) {
    const rootSharedFolder = await this.prisma.folder.findFirst({
      where: { shareToken: data.shareToken, deletedAt: null },
    });

    if (!rootSharedFolder) {
      return { isValid: false };
    }

    const fileRecord = await this.prisma.fileRecord.findFirst({
      where: { id: data.fileId, deletedAt: null },
    });

    if (!fileRecord || !fileRecord.folderId) {
      return { isValid: false };
    }

    const isValid = await this.folderService.isDescendantOf(
      fileRecord.folderId,
      rootSharedFolder.id,
    );
    return { isValid };
  }

  @GrpcMethod('CoreService', 'BatchCheckChunkStatus')
  batchCheckChunkStatus() {
    return { entries: [] };
  }

  @GrpcMethod('CoreService', 'ReportUploadFailed')
  async reportUploadFailed(data: {
    fileId: string;
    chunkIndex: number;
    reason: string;
    isChunk: boolean;
  }) {
    this.logger.warn(
      `File ${data.fileId} chunk ${data.chunkIndex} failed to upload on Go: ${data.reason}`,
    );
    await this.prisma.fileRecord.update({
      where: { id: data.fileId },
      data: { status: 'buffer_failed' },
    });
    return {};
  }

  @GrpcMethod('CoreService', 'ReportDeleteSuccess')
  async reportDeleteSuccess(data: { fileId: string }) {
    try {
      await this.prisma.fileRecord.update({
        where: { id: data.fileId },
        data: {
          telegram_deleted: true,
          telegram_delete_failed: false,
        },
      });
      this.logger.debug(
        `Marked file ${data.fileId} as successfully deleted from Telegram`,
      );
    } catch (err) {
      this.logger.error(
        `Failed to update telegram_deleted for file ${data.fileId}`,
        err,
      );
    }
    return {};
  }

  @GrpcMethod('CoreService', 'ReportDeleteFailed')
  async reportDeleteFailed(data: { fileId: string; reason: string }) {
    try {
      await this.prisma.fileRecord.update({
        where: { id: data.fileId },
        data: {
          telegram_delete_failed: true,
        },
      });
      this.logger.warn(
        `Failed to delete file ${data.fileId} from Telegram: ${data.reason}`,
      );
    } catch (err) {
      this.logger.error(
        `Failed to update telegram_delete_failed for file ${data.fileId}`,
        err,
      );
    }
    return {};
  }

  @GrpcMethod('CoreService', 'ReportFileCorrupted')
  reportFileCorrupted() {
    return {};
  }

  @GrpcMethod('CoreService', 'ReportZipReady')
  reportZipReady() {
    return {};
  }

  @GrpcMethod('CoreService', 'ReportZipFailed')
  reportZipFailed() {
    return {};
  }

  @GrpcMethod('CoreService', 'ReportBotUnauthorized')
  reportBotUnauthorized() {
    return {};
  }

  @GrpcMethod('CoreService', 'ReportEmergencyCleanup')
  reportEmergencyCleanup() {
    return {};
  }

  @GrpcMethod('CoreService', 'CheckDiskSpace')
  checkDiskSpace() {
    return { freeBytes: 0, totalBytes: 0, usagePercent: 0 };
  }

  @GrpcMethod('CoreService', 'ReportCronStats')
  reportCronStats() {
    return {};
  }
}
