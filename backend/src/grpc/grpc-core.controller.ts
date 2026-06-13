import { Controller, Logger } from '@nestjs/common';
import { GrpcMethod } from '@nestjs/microservices';
import { PrismaService } from '../prisma/prisma.service';
import { FolderService } from '../folder/folder.service';
import { BandwidthLockService } from '../common/bandwidth-lock.service';
import { DownloadZipService } from '../download-zip/download-zip.service';
import { S3AuthService } from '../s3/s3-auth.service';
import { randomUUID } from 'crypto';

@Controller()
export class GrpcCoreController {
  private readonly logger = new Logger(GrpcCoreController.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly folderService: FolderService,
    private readonly bandwidthLockService: BandwidthLockService,
    private readonly downloadZipService: DownloadZipService,
    private readonly s3AuthService: S3AuthService,
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

  @GrpcMethod('CoreService', 'ReportFileComplete')
  async reportFileComplete(data: {
    fileId: string;
    telegramFileId: string;
    telegramMessageId: number;
    botId: number;
    encryptionIv: string;
    size: number;
    etag: string;
  }) {
    const record = await this.prisma.fileRecord.findUnique({
      where: { id: data.fileId },
    });

    if (!record) {
      this.logger.warn(
        `ReportFileComplete: file record ${data.fileId} not found`,
      );
      return {};
    }

    if (record.status === 'complete') {
      this.logger.debug(
        `ReportFileComplete: file ${data.fileId} already complete, skipping`,
      );
      return {};
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.fileRecord.update({
        where: { id: data.fileId },
        data: {
          status: 'complete',
          telegramFileId: data.telegramFileId,
          telegramMessageId: data.telegramMessageId,
          botId: BigInt(data.botId),
          isEncrypted: true,
          encryptionAlgo: 'aes-256-ctr',
          encryptionIv: data.encryptionIv,
          etag: data.etag || record.etag,
          tempStorageKey: null,
        },
      });

      await tx.user.update({
        where: { id: record.userId },
        data: { usedSpace: { increment: BigInt(data.size) } },
      });
    });

    this.logger.log(
      `File dispatched by Go transfer service: "${record.filename}" (${data.size} bytes, fileId: ${data.fileId})`,
    );
    return {};
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

      tempStorageKey: record.tempStorageKey || '',

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

  // Cold-path credential lookup for Go's SigV4 verifier. Go hits Redis first
  // (write-through cache); on miss it falls back here. Returns found=false
  // (NOT a gRPC error) for unknown/inactive keys so Go can tombstone.
  @GrpcMethod('CoreService', 'GetS3Credential')
  async getS3Credential(data: { accessKeyId: string }) {
    const cred = await this.prisma.s3Credential.findUnique({
      where: { accessKeyId: data.accessKeyId },
    });

    if (!cred || !cred.isActive) {
      this.logger.debug(
        `gRPC GetS3Credential miss: accessKeyId=${data.accessKeyId}`,
      );
      return { found: false, isActive: false, userId: '', secretAccessKey: '' };
    }

    const secretAccessKey = this.s3AuthService.decryptSecretPublic(
      cred.secretAccessKey,
    );
    this.logger.debug(
      `gRPC GetS3Credential hit: accessKeyId=${data.accessKeyId} userId=${cred.userId}`,
    );
    return {
      found: true,
      isActive: true,
      userId: cred.userId,
      secretAccessKey,
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

  @GrpcMethod('CoreService', 'ReportBandwidthUsage')
  async reportBandwidthUsage(data: {
    entries: Array<{
      userId: string;
      fileId: string;
      actualBytes: number;
      countDownload: boolean;
    }>;
  }) {
    if (!data.entries || data.entries.length === 0) {
      return {};
    }

    const entries = data.entries.map((e) => ({
      userId: e.userId ?? '',
      fileId: e.fileId ?? '',
      actualBytes: BigInt(e.actualBytes ?? 0),
      countDownload: e.countDownload ?? false,
    }));

    const { accepted } =
      await this.bandwidthLockService.reconcileFromReport(entries);
    this.logger.debug(
      `Reconciled ${accepted}/${entries.length} bandwidth reports from Go`,
    );
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

  @GrpcMethod('CoreService', 'CollectZipEntries')
  async collectZipEntries(data: { jobId: string }) {
    const entries = await this.downloadZipService.collectEntries(data.jobId);
    return {
      entries: entries.map((e) => ({
        fileRecordId: e.fileRecordId,
        relativePath: e.relativePath,
        size: Number(e.size),
      })),
    };
  }

  @GrpcMethod('CoreService', 'ReportZipProgress')
  async reportZipProgress(data: { jobId: string; processedFiles: number }) {
    await this.downloadZipService.reportProgress(
      data.jobId,
      data.processedFiles ?? 0,
    );
    return {};
  }

  @GrpcMethod('CoreService', 'ReportZipReady')
  async reportZipReady(data: {
    jobId: string;
    parts: Array<{ key: string; size: number; index: number }>;
    totalSize: number;
    streaming: boolean;
  }) {
    await this.downloadZipService.markReady(
      data.jobId,
      data.parts || [],
      data.totalSize ?? 0,
    );
    this.logger.log(
      `ZIP ready (assembled by Go): jobId=${data.jobId}, parts=${(data.parts || []).length}`,
    );
    return {};
  }

  @GrpcMethod('CoreService', 'ReportZipFailed')
  async reportZipFailed(data: { jobId: string; reason: string }) {
    await this.downloadZipService.markFailed(
      data.jobId,
      data.reason || 'unknown',
    );
    this.logger.warn(
      `ZIP failed (reported by Go): jobId=${data.jobId}, reason=${data.reason}`,
    );
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
