import { Processor, WorkerHost } from '@nestjs/bullmq';
import {
  Injectable,
  Logger,
  Inject,
  OnModuleDestroy,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Job } from 'bullmq';
// @ts-ignore: archiver v8 exports ZipArchive but @types/archiver is v7
import { ZipArchive } from 'archiver';
import * as fs from 'fs';
import * as path from 'path';
import { Readable, PassThrough, Writable } from 'stream';
import { PrismaService } from '../prisma/prisma.service';
import { TelegramService, fetchWithRetry } from '../telegram/telegram.service';
import { CryptoService } from '../crypto/crypto.service';
import { TransferReadService } from '../file/transfer-read.service';
import { SettingsService } from '../settings/settings.service';
import { TEMP_STORAGE } from '../common/temp-storage';
import type { TempStorage } from '../common/temp-storage/temp-storage.interface';
import { CacheService } from '../cache/cache.service';
import { DownloadZipJobData } from '../queue';
import { DownloadZipService } from './download-zip.service';
import type {
  SingleFileDownloadInfo,
  ChunkedDownloadInfo,
} from '../common/types/download';

interface ZipPart {
  index: number;
  size: number | string;
  key: string;
}

const PART_SIZE = 2n * 1024n * 1024n * 1024n; // 2GB
const ZIP_EXPIRY_MS = 30 * 60 * 1000; // 30 minutes

const zipOwnerIsGo = (): boolean => (process.env.ZIP_OWNER || 'go') === 'go';

interface FileEntry {
  fileRecordId: string;
  relativePath: string; // e.g. "FolderA/SubFolder/file.txt"
  size: bigint;
}

// ZipSplitStream removed

@Processor('download-zip', { concurrency: 2 })
@Injectable()
export class DownloadZipProcessor
  extends WorkerHost
  implements OnModuleDestroy, OnApplicationBootstrap
{
  private readonly logger = new Logger(DownloadZipProcessor.name);
  private readonly baseDir: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly telegram: TelegramService,
    private readonly cryptoService: CryptoService,
    private readonly transferRead: TransferReadService,
    private readonly settingsService: SettingsService,
    private readonly downloadZipService: DownloadZipService,
    @Inject(TEMP_STORAGE) private readonly tempStorage: TempStorage,
    private readonly cacheService: CacheService,
  ) {
    super();
    this.baseDir = process.env.UPLOAD_BUFFER_DIR || './.upload-buffer';
  }

  async onModuleDestroy(): Promise<void> {
    if (this.worker) await this.worker.close();
  }

  async process(job: Job<DownloadZipJobData>): Promise<void> {
    if (zipOwnerIsGo()) {
      // ZIP assembly is owned by the Go transfer service. This worker is
      // disabled (paused at bootstrap); ignore any residual jobs.
      this.logger.warn(
        `Ignoring download-zip job ${job.id}: ZIP assembly owned by Go transfer service.`,
      );
      return;
    }
    const { jobId } = job.data;

    try {
      // Phase 1: Collect files
      await this.updateStatus(jobId, 'collecting');
      const entries = await this.collectFiles(jobId);

      const totalSize = entries.reduce((sum, e) => sum + e.size, 0n);
      await this.prisma.downloadJob.update({
        where: { id: jobId },
        data: { totalFiles: entries.length, totalSize },
      });

      if (entries.length === 0) {
        await this.prisma.downloadJob.update({
          where: { id: jobId },
          data: { status: 'failed', errorMessage: 'No files to download' },
        });
        return;
      }

      // Phase 2: Create ZIP (on-the-fly splitting)
      await this.updateStatus(jobId, 'zipping');
      const zipParts = await this.createZip(jobId, entries, job);

      // Phase 3: Mark ready
      await this.prisma.downloadJob.update({
        where: { id: jobId },
        data: {
          status: 'ready',
          zipParts,
          expiresAt: new Date(Date.now() + ZIP_EXPIRY_MS),
        },
      });

      this.logger.log(
        `ZIP ready: jobId=${jobId}, files=${entries.length}, ` +
          `parts=${zipParts.length}, totalSize=${totalSize}`,
      );
    } catch (err) {
      this.logger.error(`ZIP job failed: ${jobId}`, err);
      await this.cleanupJobFiles(jobId);
      await this.prisma.downloadJob
        .update({
          where: { id: jobId },
          data: {
            status: 'failed',
            errorMessage: err instanceof Error ? err.message : String(err),
          },
        })
        .catch(() => {});
      throw err;
    }
  }

  private async cleanupJobFiles(jobId: string): Promise<void> {
    const dirPath = path.join(this.baseDir, 'zip', jobId);
    await fs.promises
      .rm(dirPath, { recursive: true, force: true })
      .catch(() => {});
  }

  private async collectFiles(jobId: string): Promise<FileEntry[]> {
    const downloadJob = await this.prisma.downloadJob.findUnique({
      where: { id: jobId },
    });
    if (!downloadJob) throw new Error('Job not found');

    const fileIds = downloadJob.fileIds as string[];
    const folderIds = downloadJob.folderIds as string[];
    const entries: FileEntry[] = [];

    // Direct files
    if (fileIds.length > 0) {
      const files = await this.prisma.fileRecord.findMany({
        where: { id: { in: fileIds }, deletedAt: null, status: 'complete' },
        select: { id: true, filename: true, size: true },
      });
      for (const f of files) {
        entries.push({
          fileRecordId: f.id,
          relativePath: f.filename,
          size: f.size,
        });
      }
    }

    // Recursive folder collection
    for (const folderId of folderIds) {
      const folder = await this.prisma.folder.findUnique({
        where: { id: folderId },
        select: { name: true, userId: true },
      });
      if (!folder) continue;

      await this.collectFolderRecursive(
        folderId,
        folder.name, // root path = folder name
        folder.userId,
        entries,
      );
    }

    return entries;
  }

  private async collectFolderRecursive(
    folderId: string,
    currentPath: string,
    userId: string,
    entries: FileEntry[],
  ): Promise<void> {
    // Fetch files in current folder
    const files = await this.prisma.fileRecord.findMany({
      where: { folderId, userId, deletedAt: null, status: 'complete' },
      select: { id: true, filename: true, size: true },
    });
    for (const f of files) {
      entries.push({
        fileRecordId: f.id,
        relativePath: `${currentPath}/${f.filename}`,
        size: f.size,
      });
    }

    // Recurse into subfolders
    const subfolders = await this.prisma.folder.findMany({
      where: { parentId: folderId, deletedAt: null },
      select: { id: true, name: true, userId: true },
    });
    for (const sub of subfolders) {
      await this.collectFolderRecursive(
        sub.id,
        `${currentPath}/${sub.name}`,
        userId,
        entries,
      );
    }
  }

  private async createZip(
    jobId: string,
    entries: FileEntry[],
    bullJob: Job,
  ): Promise<{ key: string; size: number; index: number }[]> {
    const zipParts: { key: string; size: number; index: number }[] = [];
    let currentPartIndex = 0;

    let archive = new ZipArchive({ zlib: { level: 1 } });
    let output = new PassThrough();
    let currentPartKey = `zip/${jobId}/part${String(currentPartIndex).padStart(3, '0')}.zip`;
    let uploadPromise = this.tempStorage.write(currentPartKey, output);
    archive.pipe(output);

    let processed = 0;
    const skippedFiles: string[] = [];
    const seenPaths = new Set<string>();

    for (const entry of entries) {
      // Check if adding this file will exceed the part size (and the archive is not empty)
      const currentSize = archive.pointer();
      if (
        currentSize > 0 &&
        currentSize + Number(entry.size) > Number(PART_SIZE)
      ) {
        await Promise.all([archive.finalize(), uploadPromise]);

        zipParts.push({
          key: currentPartKey,
          size: archive.pointer(),
          index: currentPartIndex,
        });

        // Start new part
        currentPartIndex++;
        archive = new ZipArchive({ zlib: { level: 1 } });
        output = new PassThrough();
        currentPartKey = `zip/${jobId}/part${String(currentPartIndex).padStart(3, '0')}.zip`;
        uploadPromise = this.tempStorage.write(currentPartKey, output);
        archive.pipe(output);
      }

      // Build unique path
      let relPath = entry.relativePath;
      let counter = 1;
      const parsed = path.parse(relPath);
      while (seenPaths.has(relPath)) {
        relPath = parsed.dir
          ? `${parsed.dir}/${parsed.name}_${counter}${parsed.ext}`
          : `${parsed.name}_${counter}${parsed.ext}`;
        counter++;
      }
      seenPaths.add(relPath);

      try {
        const fileStream = await this.fetchFileStream(entry.fileRecordId);
        archive.append(fileStream, { name: relPath });

        await new Promise<void>((resolve, reject) => {
          const onEnd = () => {
            cleanup();
            resolve();
          };
          const onError = (err: unknown) => {
            cleanup();
            reject(err instanceof Error ? err : new Error(String(err)));
          };
          const cleanup = () => {
            fileStream.off('end', onEnd);
            fileStream.off('error', onError);
            archive.off('error', onError);
          };
          fileStream.on('end', onEnd);
          fileStream.on('error', onError);
          archive.on('error', onError);
        });

        processed++;
        await this.prisma.downloadJob.update({
          where: { id: jobId },
          data: { processedFiles: processed },
        });
        await bullJob.updateProgress(
          Math.round((processed / entries.length) * 100),
        );
      } catch (err) {
        this.logger.warn(
          `Skipping file ${entry.fileRecordId} (${entry.relativePath}): ${err instanceof Error ? err.message : String(err)}`,
        );
        skippedFiles.push(entry.relativePath);
        processed++;
        await this.prisma.downloadJob.update({
          where: { id: jobId },
          data: { processedFiles: processed },
        });
        await bullJob.updateProgress(
          Math.round((processed / entries.length) * 100),
        );
      }
    }

    // Finalize the last part
    await Promise.all([archive.finalize(), uploadPromise]);

    zipParts.push({
      key: currentPartKey,
      size: archive.pointer(),
      index: currentPartIndex,
    });

    if (skippedFiles.length > 0) {
      this.logger.warn(`ZIP ${jobId}: skipped ${skippedFiles.length} files`);
    }

    return zipParts;
  }

  private async fetchFileStream(fileRecordId: string): Promise<Readable> {
    const fileRecord = await this.prisma.fileRecord.findUnique({
      where: { id: fileRecordId },
      include: { chunks: { orderBy: { chunkIndex: 'asc' } } },
    });
    if (!fileRecord) throw new Error(`File ${fileRecordId} not found`);

    const downloadInfo = this.transferRead.getDownloadMetadata(fileRecord);

    // Case 1: Buffered file
    if ('isBuffered' in downloadInfo && downloadInfo.isBuffered) {
      return this.tempStorage.read(downloadInfo.tempStorageKey);
    }

    // Case 2: Single file
    if (!downloadInfo.isChunked) {
      const info = downloadInfo as SingleFileDownloadInfo;
      const url = await this.resolveFileLink(
        info.telegramFileId,
        info.botId,
        info.telegramMessageId,
      );
      const fetchRes = await fetchWithRetry(url);
      if (!fetchRes.ok || !fetchRes.body)
        throw new Error('Telegram fetch failed');

      const webStream =
        fetchRes.body as unknown as import('stream/web').ReadableStream;
      let stream: Readable = Readable.fromWeb(webStream);

      if (info.isEncrypted && info.dek && info.iv) {
        const decipher = this.cryptoService.createDecryptStream(
          info.dek,
          info.iv,
        );
        stream = stream.pipe(decipher);
      }

      return stream;
    }

    // Case 3: Chunked file
    const info = downloadInfo as ChunkedDownloadInfo;
    const passThrough = new PassThrough();

    void (async () => {
      try {
        for (const chunk of info.chunks) {
          let chunkStream: Readable;

          if (chunk.isBuffered && chunk.tempStorageKey) {
            chunkStream = await this.tempStorage.read(chunk.tempStorageKey);
          } else {
            const url = await this.resolveFileLink(
              chunk.telegramFileId!,
              chunk.botId,
              chunk.telegramMessageId,
            );
            const fetchRes = await fetchWithRetry(url);
            if (!fetchRes.ok || !fetchRes.body)
              throw new Error('Chunk fetch failed');
            const webStream =
              fetchRes.body as unknown as import('stream/web').ReadableStream;
            chunkStream = Readable.fromWeb(webStream);
          }

          if (!chunk.isBuffered && info.isEncrypted && info.dek && chunk.iv) {
            const decipher = this.cryptoService.createDecryptStream(
              info.dek,
              chunk.iv,
            );
            chunkStream = chunkStream.pipe(decipher);
          }

          await new Promise<void>((resolve, reject) => {
            chunkStream.on('end', resolve);
            chunkStream.on('error', reject);
            chunkStream.pipe(passThrough, { end: false });
          });
        }
        passThrough.end();
      } catch (err) {
        passThrough.destroy(
          err instanceof Error ? err : new Error(String(err)),
        );
      }
    })();

    return passThrough;
  }

  private async resolveFileLink(
    telegramFileId: string,
    botId: bigint,
    messageId: number | null,
  ): Promise<string> {
    if (this.telegram.isBotAvailable(botId)) {
      return this.telegram.getFileLink(telegramFileId, botId, 'zip-download');
    }
    try {
      return await this.telegram.getFileLink(
        telegramFileId,
        this.telegram.mainBotTelegramId,
        'zip-download',
      );
    } catch {
      if (!messageId) throw new Error(`Bot ${botId} unavailable, no messageId`);
      const { fileId } = await this.telegram.recoverFileId(messageId);
      return this.telegram.getFileLink(
        fileId,
        this.telegram.mainBotTelegramId,
        'zip-download',
      );
    }
  }

  @Cron('*/5 * * * *')
  async cleanupExpiredZips(): Promise<void> {
    // Single-flight across NestJS instances: only one runs per 5-min period.
    // No explicit release — TTL (240s) expires before the next fire so the
    // following period can re-acquire; mirrors the other cron lock pattern.
    const acquired = await this.cacheService.acquireLock(
      'cron:cleanup-expired-zips',
      240,
    );
    if (!acquired) {
      this.logger.debug('Cron cleanup-expired-zips running elsewhere, skipping');
      return;
    }

    const expired = await this.prisma.downloadJob.findMany({
      where: { status: 'ready', expiresAt: { lt: new Date() } },
    });

    for (const job of expired) {
      if (await this.downloadZipService.hasActiveStreams(job.id)) {
        this.logger.debug(`Skipping cleanup for ${job.id}: active streams`);
        continue;
      }

      const parts = (job.zipParts as unknown as ZipPart[]) || [];
      for (const part of parts) {
        await this.tempStorage.delete(part.key).catch(() => {});
      }
      await this.cleanupJobFiles(job.id);

      await this.prisma.downloadJob.update({
        where: { id: job.id },
        data: { status: 'expired' },
      });
      this.logger.log(`Expired ZIP cleaned up: ${job.id}`);
    }

    const stuckCutoff = new Date(Date.now() - 2 * 60 * 60 * 1000);
    const stuckJobs = await this.prisma.downloadJob.findMany({
      where: {
        status: { in: ['pending', 'collecting', 'zipping'] },
        createdAt: { lt: stuckCutoff },
      },
    });

    if (stuckJobs.length > 0) {
      for (const job of stuckJobs) {
        await this.cleanupJobFiles(job.id);
        await this.prisma.downloadJob.update({
          where: { id: job.id },
          data: { status: 'failed', errorMessage: 'Job timed out' },
        });
      }
      this.logger.warn(
        `Marked ${stuckJobs.length} stuck ZIP jobs as failed and cleaned up`,
      );
    }
  }

  private async updateStatus(jobId: string, status: string): Promise<void> {
    await this.prisma.downloadJob.update({
      where: { id: jobId },
      data: { status },
    });
  }

  async onApplicationBootstrap(): Promise<void> {
    if (process.env.IS_TRANSFER_SERVICE === 'false' || zipOwnerIsGo()) {
      this.logger.log(
        zipOwnerIsGo()
          ? 'ZIP_OWNER=go. ZIP assembly handled by Go transfer service; pausing NestJS worker.'
          : 'IS_TRANSFER_SERVICE is false. Pausing download-zip queue worker.',
      );
      if (this.worker) {
        await this.worker.pause();
      }
    }
  }
}
