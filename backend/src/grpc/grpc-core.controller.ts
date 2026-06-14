import { Controller, Logger } from '@nestjs/common';
import { GrpcMethod } from '@nestjs/microservices';
import { PrismaService } from '../prisma/prisma.service';
import { FolderService } from '../folder/folder.service';
import { BandwidthLockService } from '../common/bandwidth-lock.service';
import { DownloadZipService } from '../download-zip/download-zip.service';
import { S3AuthService } from '../s3/s3-auth.service';
import { S3Service } from '../s3/s3.service';
import { CryptoService } from '../crypto/crypto.service';
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
    private readonly s3Service: S3Service,
    private readonly cryptoService: CryptoService,
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
    const touchedFileIds = new Set<string>();
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
        touchedFileIds.add(chunk.fileId);
      } catch (err) {
        this.logger.error(
          `Failed to upsert chunk ${chunk.chunkIndex} for file ${chunk.fileId}`,
          err,
        );
      }
    }

    // A chunked file is "complete" once every declared chunk has landed on
    // Telegram. This handler is the SOLE place that performs the
    // buffered/uploading → complete flip and charges storage quota, so the flip
    // works no matter whether the client's /complete call arrives before or
    // after the final chunk drains (the async buffer never blocks on Telegram).
    for (const fileId of touchedFileIds) {
      await this.finalizeChunkedFileIfLanded(fileId);
    }

    return { accepted };
  }

  /**
   * Persist a FileChunk row the instant Go accepts a chunk to temp storage,
   * BEFORE the slow Telegram upload. The row carries the temp storage key and a
   * null telegramFileId, so the download path can serve the chunk straight from
   * temp disk while it drains — mirroring the legacy NestJS acceptChunk. The
   * subsequent ReportChunkResults flips the same row (matched on
   * fileId+chunkIndex) to status=complete with the Telegram coordinates. Upsert
   * keeps this idempotent and avoids clobbering a row that already completed
   * (e.g. a retried receive landing after the upload finished).
   */
  @GrpcMethod('CoreService', 'ReportChunkBuffered')
  async reportChunkBuffered(data: {
    chunks: Array<{
      fileId: string;
      chunkIndex: number;
      size: number;
      tempStorageKey: string;
      encryptionIv: string;
      etag: string;
      chunkId: string;
    }>;
  }) {
    if (!data.chunks || data.chunks.length === 0) {
      return { accepted: 0 };
    }

    let accepted = 0;
    for (const chunk of data.chunks) {
      try {
        await this.prisma.fileChunk.upsert({
          where: {
            fileId_chunkIndex: {
              fileId: chunk.fileId,
              chunkIndex: chunk.chunkIndex,
            },
          },
          // Never downgrade a chunk that already completed; only refresh the
          // buffered placeholder's temp key / metadata.
          update: {},
          create: {
            id: chunk.chunkId || randomUUID(),
            fileId: chunk.fileId,
            chunkIndex: chunk.chunkIndex,
            size: chunk.size,
            telegramFileId: null,
            tempStorageKey: chunk.tempStorageKey,
            encryptionIv: chunk.encryptionIv || null,
            etag: chunk.etag || null,
            status: 'buffered',
          },
        });
        accepted++;
      } catch (err) {
        this.logger.error(
          `Failed to persist buffered chunk ${chunk.chunkIndex} for file ${chunk.fileId}`,
          err,
        );
      }
    }

    this.logger.debug(
      `Persisted ${accepted}/${data.chunks.length} buffered chunk rows from Go`,
    );
    return { accepted };
  }

  /**
   * Flip a chunked FileRecord to `complete` and charge storage quota exactly
   * once, but only after all declared chunks have landed on Telegram. The
   * atomic `updateMany` guard (status in uploading/buffered → complete) ensures
   * that of all the racing callers — concurrent chunk reports, or the client's
   * /complete parking the record — exactly one wins the transition and thus
   * charges quota a single time.
   */
  private async finalizeChunkedFileIfLanded(fileId: string): Promise<void> {
    try {
      const record = await this.prisma.fileRecord.findUnique({
        where: { id: fileId },
        select: {
          status: true,
          totalChunks: true,
          size: true,
          userId: true,
          filename: true,
        },
      });
      if (!record) return;
      if (record.status === 'complete' || record.status === 'aborted') return;

      const landed = await this.prisma.fileChunk.count({
        where: { fileId, telegramFileId: { not: null } },
      });
      if (landed < record.totalChunks) return;

      const flip = await this.prisma.fileRecord.updateMany({
        where: { id: fileId, status: { in: ['uploading', 'buffered'] } },
        data: { status: 'complete' },
      });
      if (flip.count !== 1) return; // another caller already won the transition

      await this.prisma.user.update({
        where: { id: record.userId },
        data: { usedSpace: { increment: record.size } },
      });

      this.logger.log(
        `Chunked file completed via chunk report: "${record.filename}" ` +
          `(fileId: ${fileId}, ${landed}/${record.totalChunks} chunks, ${record.size} bytes)`,
      );
    } catch (err) {
      this.logger.error(
        `Failed to finalize chunked file ${fileId} after chunk report`,
        err,
      );
    }
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

  // Resolve (bucket, key) → FileRecord for Go's S3 GET/HEAD data plane.
  // Reuses S3Service.findObject so bucket→folder + key→path resolution stays
  // in one place. Returns found=false (NOT a gRPC error) for unknown keys so
  // Go can emit a NoSuchKey XML without info leak.
  @GrpcMethod('CoreService', 'ResolveS3Object')
  async resolveS3Object(data: { userId: string; bucket: string; key: string }) {
    try {
      const file = await this.s3Service.findObject(
        data.userId,
        data.bucket,
        data.key,
      );
      this.logger.debug(
        `gRPC ResolveS3Object hit: userId=${data.userId} bucket=${data.bucket} key=${data.key} fileId=${file.id}`,
      );
      return {
        found: true,
        fileId: file.id,
        mimeType: file.mimeType,
        size: Number(file.size),
        etag: file.etag || `"${file.id}"`,
        lastModified: file.updatedAt.toUTCString(),
      };
    } catch {
      this.logger.debug(
        `gRPC ResolveS3Object miss: userId=${data.userId} bucket=${data.bucket} key=${data.key}`,
      );
      return {
        found: false,
        fileId: '',
        mimeType: '',
        size: 0,
        etag: '',
        lastModified: '',
      };
    }
  }

  // Provision an S3 PutObject before Go ingests the body. Mirrors the legacy
  // redirectPutObject: zero-byte key → folder marker (fileId empty signals Go to
  // skip ingest); else create an 'uploading' FileRecord with encryption keyed
  // upfront so Go encrypts the stream (Go has no MASTER_SECRET). Go reports back
  // via ReportS3PutComplete once the body lands on Telegram.
  @GrpcMethod('CoreService', 'PrepareS3Put')
  async prepareS3Put(data: {
    userId: string;
    bucket: string;
    key: string;
    mimeType: string;
    contentLength: number;
  }) {
    // Zero-byte object → folder marker. Resolve/create the folder chain and
    // return an empty fileId so Go responds 200 without uploading anything.
    if (!data.contentLength || data.contentLength === 0) {
      const folderKey = data.key.endsWith('/') ? data.key : `${data.key}/`;
      const folderId = await this.s3Service.resolveKeyAsFolder(
        data.userId,
        data.bucket,
        folderKey,
      );
      this.logger.log(
        `gRPC PrepareS3Put folder marker: userId=${data.userId} bucket=${data.bucket} key=${folderKey}`,
      );
      return { fileId: '', folderId, encryptedKey: '', isEncrypted: false };
    }

    const filename = data.key.split('/').pop() || data.key;
    const { folderId } = await this.s3Service.resolveKey(
      data.userId,
      data.bucket,
      data.key,
      true,
    );

    const encryptedKey = this.cryptoService.encryptKey(
      this.cryptoService.generateFileKey(),
    );
    const fileRecord = await this.prisma.fileRecord.create({
      data: {
        filename,
        size: BigInt(data.contentLength),
        mimeType: data.mimeType || 'application/octet-stream',
        status: 'uploading',
        isEncrypted: true,
        encryptionAlgo: 'aes-256-ctr',
        encryptedKey,
        folderId: folderId || null,
        userId: data.userId,
      },
    });

    this.logger.log(
      `gRPC PrepareS3Put: userId=${data.userId} bucket=${data.bucket} key=${data.key} fileId=${fileRecord.id} (${data.contentLength} bytes)`,
    );
    return {
      fileId: fileRecord.id,
      folderId: folderId || '',
      encryptedKey,
      isEncrypted: true,
    };
  }

  // Finalize an S3 PutObject after Go uploads the (encrypted) body to Telegram.
  // Marks the record complete, increments quota, and soft-deletes prior versions
  // of the same (folderId, filename) — overwrite-to-trash AFTER success, matching
  // the legacy doPutObject semantics so a failed upload never destroys old data.
  @GrpcMethod('CoreService', 'ReportS3PutComplete')
  async reportS3PutComplete(data: {
    fileId: string;
    telegramFileId: string;
    telegramMessageId: number;
    botId: number;
    encryptionIv: string;
    size: number;
    etag: string;
    isChunked: boolean;
    totalChunks: number;
  }) {
    const record = await this.prisma.fileRecord.findUnique({
      where: { id: data.fileId },
    });
    if (!record) {
      this.logger.warn(
        `gRPC ReportS3PutComplete: file record ${data.fileId} not found`,
      );
      return {};
    }
    if (record.status === 'complete') {
      this.logger.debug(
        `gRPC ReportS3PutComplete: file ${data.fileId} already complete, skipping`,
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
          isChunked: data.isChunked,
          totalChunks: data.totalChunks,
          tempStorageKey: null,
        },
      });

      // Overwrite: soft-delete older complete versions of the same key.
      if (record.filename) {
        const stale = await tx.fileRecord.findMany({
          where: {
            userId: record.userId,
            folderId: record.folderId,
            filename: record.filename,
            id: { not: record.id },
            deletedAt: null,
          },
          select: { id: true },
        });
        if (stale.length > 0) {
          await tx.fileRecord.updateMany({
            where: { id: { in: stale.map((f) => f.id) } },
            data: { deletedAt: new Date() },
          });
          this.logger.log(
            `gRPC ReportS3PutComplete overwrite: moved ${stale.length} prior version(s) to trash for fileId=${data.fileId}`,
          );
        }
      }

      await tx.user.update({
        where: { id: record.userId },
        data: { usedSpace: { increment: BigInt(data.size) } },
      });
    });

    this.logger.log(
      `gRPC ReportS3PutComplete: "${record.filename}" finalized (${data.size} bytes, fileId: ${data.fileId})`,
    );
    return {};
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

  // Cache-aside source for the Go data plane's bandwidth enforcement. Go hits
  // Redis first; on miss it calls this to seed the quota hash. Read-only — the
  // 24h reset is applied virtually (no DB write); Go owns the Redis lock and the
  // cron/lock path owns the real reset write.
  @GrpcMethod('CoreService', 'GetBandwidthQuota')
  async getBandwidthQuota(data: {
    userId?: string;
    ip?: string;
    fileId?: string;
  }) {
    const snap = await this.bandwidthLockService.getQuotaSnapshot(
      data.userId ?? '',
      data.ip ?? '',
      data.fileId ?? '',
    );
    return {
      dailyUsed: Number(snap.dailyUsed),
      dailyLimit: Number(snap.dailyLimit ?? 0n),
      lastReset: snap.lastReset.toISOString(),
      isGuest: snap.isGuest,
      fileDownloads24h: snap.file?.downloads24h ?? 0,
      fileDownloadLimit24h: snap.file?.downloadLimit24h ?? 0,
      fileBandwidthUsed24h: Number(snap.file?.bandwidthUsed24h ?? 0n),
      fileBandwidthLimit24h: Number(snap.file?.bandwidthLimit24h ?? 0n),
      fileLastDownloadReset: (
        snap.file?.lastDownloadReset ?? snap.lastReset
      ).toISOString(),
    };
  }

  // Cache-aside source for the Go data plane's system settings. Go caches the
  // returned map in-memory with a short TTL so admin-dashboard changes propagate
  // without a redeploy. Read-only; returns raw string values (Go parses per key).
  @GrpcMethod('CoreService', 'GetSystemSettings')
  async getSystemSettings(data: { keys?: string[] }) {
    const where =
      data.keys && data.keys.length > 0
        ? { key: { in: data.keys } }
        : undefined;
    const rows = await this.prisma.systemSetting.findMany({ where });
    const settings: Record<string, string> = {};
    for (const row of rows) {
      settings[row.key] = row.value;
    }
    return { settings };
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

  // Serve-side lookup for the Go data plane (Go owns ZIP part streaming but has
  // no DB). Returns found=false for unknown jobs so Go emits a clean 404 instead
  // of a gRPC error. Parts carry the temp-storage key Go reads from disk.
  @GrpcMethod('CoreService', 'GetZipJob')
  async getZipJob(data: { jobId: string }) {
    const info = await this.downloadZipService.getServeInfo(data.jobId);
    return {
      found: info.found,
      status: info.status,
      createdAt: info.createdAt,
      expiresAt: info.expiresAt,
      parts: info.parts.map((p) => ({
        key: p.key,
        size: Number(p.size),
        index: p.index,
      })),
    };
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
