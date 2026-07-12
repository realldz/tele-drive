import {
  Injectable,
  BadRequestException,
  ConflictException,
  NotFoundException,
  Inject,
  Logger,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { SettingsService } from '../settings/settings.service';
import { BandwidthLockService } from '../common/bandwidth-lock.service';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { DOWNLOAD_ZIP_QUEUE, DownloadZipJobData } from '../queue';
import { FolderService } from '../folder/folder.service';
import Redis from 'ioredis';
import { REDIS_CLIENT } from '../redis';
import * as fs from 'fs';
import * as path from 'path';

// Redis key holding the live count of in-flight ZIP part streams for a job.
// Go (which now owns part serving) INCRs on stream start and DECRs on end; the
// NestJS cleanup cron reads it to avoid deleting parts mid-download. Keyed by
// jobId. A TTL on the key (set by Go) bounds any leak if a DECR is ever missed.
export const ZIP_STREAM_ACTIVE_PREFIX = 'zip:stream:active:';

interface ZipPart {
  index: number;
  size: number | string;
  key: string;
}

export interface DownloadZipPartResponse {
  index: number;
  size: string;
  downloadUrl: string;
}

export interface DownloadZipStatusResponse {
  jobId: string;
  status: string;
  totalFiles: number;
  processedFiles: number;
  totalSize: string;
  parts: DownloadZipPartResponse[];
  expiresAt: string | null;
  error: string | null;
}

@Injectable()
export class DownloadZipService {
  private readonly logger = new Logger(DownloadZipService.name);
  private readonly baseDir: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly settingsService: SettingsService,
    private readonly bandwidthLockService: BandwidthLockService,
    private readonly folderService: FolderService,
    @InjectQueue(DOWNLOAD_ZIP_QUEUE) private readonly zipQueue: Queue,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {
    this.baseDir = process.env.UPLOAD_BUFFER_DIR || './.upload-buffer';
  }

  private zipOwnerIsGo(): boolean {
    return (process.env.ZIP_OWNER || 'go') === 'go';
  }

  /**
   * Dispatch a ZIP job either to the Go transfer service (via Redis event)
   * or to the local BullMQ worker (legacy path).
   */
  private async dispatchZipJob(
    jobId: string,
    userId: string,
    shareToken: string | null,
  ): Promise<void> {
    if (this.zipOwnerIsGo()) {
      // XADD (not PUBLISH): consumed by a Go consumer group so exactly one
      // transfer instance assembles each ZIP. MAXLEN ~ caps stream growth.
      // See plan #1 (file:events migration).
      await this.redis.xadd(
        'file:events',
        'MAXLEN',
        '~',
        10000,
        '*',
        'payload',
        JSON.stringify({
          type: 'CREATE_ZIP',
          payload: { jobId },
        }),
      );
      this.logger.debug(`Published CREATE_ZIP event for job ${jobId}`);
      return;
    }

    await this.zipQueue.add(
      'create-zip',
      {
        jobId,
        userId,
        shareToken,
      } satisfies DownloadZipJobData,
      {
        jobId: `zip-${jobId}`,
        attempts: 2,
        backoff: { type: 'exponential', delay: 10000 },
        removeOnComplete: true,
        removeOnFail: 50,
      },
    );
  }

  async createJob(
    userId: string,
    fileIds?: string[],
    folderIds?: string[],
    ip?: string,
  ): Promise<{ jobId: string; status: string }> {
    const effectiveFileIds = fileIds || [];
    const effectiveFolderIds = folderIds || [];

    if (effectiveFileIds.length === 0 && effectiveFolderIds.length === 0) {
      throw new BadRequestException('At least one fileId or folderId required');
    }

    // Check no active job for this user
    const existing = await this.prisma.downloadJob.findFirst({
      where: {
        userId,
        status: { in: ['pending', 'collecting', 'zipping', 'splitting'] },
      },
    });
    if (existing) {
      throw new ConflictException('A download job is already in progress');
    }

    // Validate all IDs belong to user
    if (effectiveFileIds.length > 0) {
      const count = await this.prisma.fileRecord.count({
        where: {
          id: { in: effectiveFileIds },
          userId,
          deletedAt: null,
          status: 'complete',
        },
      });
      if (count !== effectiveFileIds.length) {
        throw new BadRequestException('Some files not found or not accessible');
      }
    }
    if (effectiveFolderIds.length > 0) {
      const count = await this.prisma.folder.count({
        where: { id: { in: effectiveFolderIds }, userId, deletedAt: null },
      });
      if (count !== effectiveFolderIds.length) {
        throw new BadRequestException(
          'Some folders not found or not accessible',
        );
      }
    }

    // Calculate size and count
    const { totalSize, totalFiles } = await this.calculateSizeAndCount(
      effectiveFileIds,
      effectiveFolderIds,
      userId,
    );

    // Check disk space (best-effort)
    try {
      const stats = await fs.promises.statfs(path.resolve(this.baseDir));
      const availableSpace = stats.bavail * stats.bsize;
      if (BigInt(availableSpace) < totalSize) {
        throw new BadRequestException(
          'Insufficient server disk space to prepare ZIP',
        );
      }
    } catch (err) {
      if (err instanceof HttpException) throw err;
      this.logger.warn(
        `Failed to check disk space: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // Pre-check user bandwidth
    if (ip) {
      try {
        await this.bandwidthLockService.lockBandwidth(userId, totalSize, ip);
      } catch (err: unknown) {
        if (err instanceof Error && err.message.includes('BANDWIDTH_LIMIT')) {
          const [code, resetAt] = err.message.split(':');
          throw new HttpException(
            { code, message: 'Bandwidth limit exceeded', resetAt },
            HttpStatus.TOO_MANY_REQUESTS,
          );
        }
        throw err;
      }
    }

    // Create DownloadJob
    const job = await this.prisma.downloadJob.create({
      data: {
        userId,
        fileIds: effectiveFileIds,
        folderIds: effectiveFolderIds,
        totalFiles,
        totalSize,
      },
    });

    // Dispatch to Go transfer service (Redis event) or legacy BullMQ worker
    await this.dispatchZipJob(job.id, userId, null);

    return { jobId: job.id, status: 'pending' };
  }

  async createSharedJob(
    shareToken: string,
    fileIds?: string[],
    folderIds?: string[],
    ip?: string,
  ): Promise<{ jobId: string; status: string }> {
    const rootFolder = await this.prisma.folder.findUnique({
      where: { shareToken },
    });
    if (!rootFolder || rootFolder.deletedAt) {
      throw new NotFoundException('Shared folder not found');
    }

    const effectiveFolderIds =
      !fileIds?.length && !folderIds?.length
        ? [rootFolder.id]
        : folderIds || [];
    const effectiveFileIds = fileIds || [];

    // Validate all IDs are descendants of root shared folder
    for (const fid of effectiveFileIds) {
      const file = await this.prisma.fileRecord.findFirst({
        where: { id: fid, deletedAt: null, status: 'complete' },
        select: { folderId: true },
      });
      if (!file?.folderId) throw new BadRequestException('File not accessible');

      const isDescendant = await this.folderService.isDescendantOf(
        file.folderId,
        rootFolder.id,
      );
      if (!isDescendant) {
        throw new BadRequestException('File is not in the shared folder');
      }
    }

    for (const fid of effectiveFolderIds) {
      if (fid === rootFolder.id) continue;
      const isDescendant = await this.folderService.isDescendantOf(
        fid,
        rootFolder.id,
      );
      if (!isDescendant) {
        throw new BadRequestException('Folder is not in the shared folder');
      }
    }

    // Calculate size and count
    const { totalSize, totalFiles } = await this.calculateSizeAndCount(
      effectiveFileIds,
      effectiveFolderIds,
      rootFolder.userId,
    );

    // Check disk space (best-effort)
    try {
      const stats = await fs.promises.statfs(path.resolve(this.baseDir));
      const availableSpace = stats.bavail * stats.bsize;
      if (BigInt(availableSpace) < totalSize) {
        throw new BadRequestException(
          'Insufficient server disk space to prepare ZIP',
        );
      }
    } catch (err) {
      if (err instanceof HttpException) throw err;
      this.logger.warn(
        `Failed to check disk space: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // Pre-check IP-based bandwidth (GuestTracker)
    if (ip) {
      try {
        await this.bandwidthLockService.lockBandwidth(undefined, totalSize, ip);
      } catch (err: unknown) {
        if (err instanceof Error && err.message.includes('BANDWIDTH_LIMIT')) {
          const [code, resetAt] = err.message.split(':');
          throw new HttpException(
            { code, message: 'Bandwidth limit exceeded', resetAt },
            HttpStatus.TOO_MANY_REQUESTS,
          );
        }
        throw err;
      }
    }

    // Check no active job for this shareToken + IP
    const existing = await this.prisma.downloadJob.findFirst({
      where: {
        shareToken,
        status: { in: ['pending', 'collecting', 'zipping', 'splitting'] },
      },
    });
    if (existing) {
      throw new ConflictException(
        'A download job is already in progress for this share',
      );
    }

    // Create DownloadJob
    const job = await this.prisma.downloadJob.create({
      data: {
        shareToken,
        userId: rootFolder.userId, // owner's userId for file access
        fileIds: effectiveFileIds,
        folderIds: effectiveFolderIds,
        totalFiles,
        totalSize,
      },
    });

    // Dispatch to Go transfer service (Redis event) or legacy BullMQ worker
    await this.dispatchZipJob(job.id, rootFolder.userId, shareToken);

    return { jobId: job.id, status: 'pending' };
  }

  async getJobStatus(jobId: string): Promise<DownloadZipStatusResponse> {
    const job = await this.prisma.downloadJob.findUnique({
      where: { id: jobId },
    });
    if (!job) throw new NotFoundException('Job not found');

    const rawParts = (job.zipParts as unknown as ZipPart[]) || [];
    const parts = rawParts.map((p, i) => ({
      index: p.index ?? i,
      size: String(p.size),
      downloadUrl: `/transfer/download-zip/${jobId}/file/${p.index ?? i}`,
    }));

    return {
      jobId: job.id,
      status: job.status,
      totalFiles: job.totalFiles,
      processedFiles: job.processedFiles,
      totalSize: String(job.totalSize),
      parts,
      expiresAt: job.expiresAt?.toISOString() || null,
      error: job.errorMessage,
    };
  }

  /**
   * Serve-side job lookup for the Go data plane (gRPC GetZipJob). Go owns ZIP
   * part streaming but has no DB, so it calls this to validate a part download
   * (status/expiry) and to build the attachment filename. Returns found=false
   * (not an exception) for an unknown job so Go can emit a clean 404.
   */
  async getServeInfo(jobId: string): Promise<{
    found: boolean;
    status: string;
    createdAt: string;
    expiresAt: string;
    parts: Array<{ key: string; size: string; index: number }>;
  }> {
    const job = await this.prisma.downloadJob.findUnique({
      where: { id: jobId },
    });
    if (!job) {
      return {
        found: false,
        status: '',
        createdAt: '',
        expiresAt: '',
        parts: [],
      };
    }

    const rawParts = (job.zipParts as unknown as ZipPart[]) || [];
    return {
      found: true,
      status: job.status,
      createdAt: job.createdAt.toISOString(),
      expiresAt: job.expiresAt?.toISOString() || '',
      parts: rawParts.map((p, i) => ({
        key: p.key,
        size: String(p.size),
        index: p.index ?? i,
      })),
    };
  }

  // Go INCRs zip:stream:active:{jobId} on part-stream start and DECRs on end, so
  // a non-zero (or still-existing) key means a download is in flight. The cron
  // reads this to avoid deleting parts mid-download.
  async hasActiveStreams(jobId: string): Promise<boolean> {
    const raw = await this.redis.get(`${ZIP_STREAM_ACTIVE_PREFIX}${jobId}`);
    return raw !== null && Number(raw) > 0;
  }

  /**
   * Resolve a download job into a flat list of file entries (with archive-relative
   * paths). Used by the Go transfer service via gRPC CollectZipEntries so that Go
   * stays DB-free while NestJS owns folder recursion / access logic.
   */
  async collectEntries(
    jobId: string,
  ): Promise<
    Array<{ fileRecordId: string; relativePath: string; size: string }>
  > {
    const job = await this.prisma.downloadJob.findUnique({
      where: { id: jobId },
    });
    if (!job) throw new NotFoundException('Job not found');

    const fileIds = (job.fileIds as string[]) || [];
    const folderIds = (job.folderIds as string[]) || [];
    const entries: Array<{
      fileRecordId: string;
      relativePath: string;
      size: bigint;
    }> = [];

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

    for (const folderId of folderIds) {
      const folder = await this.prisma.folder.findUnique({
        where: { id: folderId },
        select: { name: true, userId: true },
      });
      if (!folder) continue;
      await this.collectFolderEntriesRecursive(
        folderId,
        folder.name,
        folder.userId,
        entries,
      );
    }

    // Persist totals so progress reporting has a denominator
    const totalSize = entries.reduce((sum, e) => sum + e.size, 0n);
    await this.prisma.downloadJob.update({
      where: { id: jobId },
      data: { totalFiles: entries.length, totalSize, status: 'zipping' },
    });

    return entries.map((e) => ({
      fileRecordId: e.fileRecordId,
      relativePath: e.relativePath,
      size: String(e.size),
    }));
  }

  private async collectFolderEntriesRecursive(
    folderId: string,
    currentPath: string,
    userId: string,
    entries: Array<{
      fileRecordId: string;
      relativePath: string;
      size: bigint;
    }>,
  ): Promise<void> {
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

    const subfolders = await this.prisma.folder.findMany({
      where: { parentId: folderId, deletedAt: null },
      select: { id: true, name: true, userId: true },
    });
    for (const sub of subfolders) {
      await this.collectFolderEntriesRecursive(
        sub.id,
        `${currentPath}/${sub.name}`,
        userId,
        entries,
      );
    }
  }

  /** Record incremental progress reported by the Go ZIP worker. */
  async reportProgress(jobId: string, processedFiles: number): Promise<void> {
    await this.prisma.downloadJob
      .update({
        where: { id: jobId },
        data: { processedFiles },
      })
      .catch(() => {});
  }

  /** Mark a ZIP job ready with its assembled parts (reported by Go). */
  async markReady(
    jobId: string,
    parts: Array<{ key: string; size: number | string; index: number }>,
    totalSize: number | string,
  ): Promise<void> {
    const ZIP_EXPIRY_MS = 30 * 60 * 1000;
    await this.prisma.downloadJob.update({
      where: { id: jobId },
      data: {
        status: 'ready',
        zipParts: parts.map((p) => ({
          key: p.key,
          size: String(p.size),
          index: p.index,
        })),
        totalSize: BigInt(totalSize),
        expiresAt: new Date(Date.now() + ZIP_EXPIRY_MS),
      },
    });
  }

  /** Mark a ZIP job failed (reported by Go) and clean up any partial parts. */
  async markFailed(jobId: string, reason: string): Promise<void> {
    const dirPath = path.join(this.baseDir, 'zip', jobId);
    await fs.promises
      .rm(dirPath, { recursive: true, force: true })
      .catch(() => {});
    await this.prisma.downloadJob
      .update({
        where: { id: jobId },
        data: { status: 'failed', errorMessage: reason },
      })
      .catch(() => {});
  }

  private async calculateSizeAndCount(
    fileIds: string[],
    folderIds: string[],
    userId: string,
  ): Promise<{ totalSize: bigint; totalFiles: number }> {
    let totalSize = 0n;
    let totalFiles = 0;

    if (fileIds.length > 0) {
      const files = await this.prisma.fileRecord.findMany({
        where: {
          id: { in: fileIds },
          userId,
          deletedAt: null,
          status: 'complete',
        },
        select: { size: true },
      });
      totalFiles += files.length;
      for (const f of files) {
        totalSize += f.size;
      }
    }

    for (const folderId of folderIds) {
      const res = await this.calculateFolderSizeRecursive(folderId, userId);
      totalSize += res.size;
      totalFiles += res.count;
    }

    return { totalSize, totalFiles };
  }

  private async calculateFolderSizeRecursive(
    folderId: string,
    userId: string,
  ): Promise<{ size: bigint; count: number }> {
    let size = 0n;
    let count = 0;

    const files = await this.prisma.fileRecord.findMany({
      where: { folderId, userId, deletedAt: null, status: 'complete' },
      select: { size: true },
    });
    count += files.length;
    for (const f of files) {
      size += f.size;
    }

    const subfolders = await this.prisma.folder.findMany({
      where: { parentId: folderId, deletedAt: null },
      select: { id: true },
    });
    for (const sub of subfolders) {
      const subRes = await this.calculateFolderSizeRecursive(sub.id, userId);
      size += subRes.size;
      count += subRes.count;
    }

    return { size, count };
  }
}
