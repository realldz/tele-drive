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
import { TEMP_STORAGE } from '../common/temp-storage';
import type { TempStorage } from '../common/temp-storage/temp-storage.interface';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { DOWNLOAD_ZIP_QUEUE, DownloadZipJobData } from '../queue';
import { FolderService } from '../folder/folder.service';
import { Response } from 'express';
import * as fs from 'fs';
import * as path from 'path';

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
  private readonly activeStreams = new Map<string, number>();
  private readonly baseDir: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly settingsService: SettingsService,
    private readonly bandwidthLockService: BandwidthLockService,
    private readonly folderService: FolderService,
    @InjectQueue(DOWNLOAD_ZIP_QUEUE) private readonly zipQueue: Queue,
    @Inject(TEMP_STORAGE) private readonly tempStorage: TempStorage,
  ) {
    this.baseDir = process.env.UPLOAD_BUFFER_DIR || './.upload-buffer';
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

    // Enqueue BullMQ job
    await this.zipQueue.add(
      'create-zip',
      {
        jobId: job.id,
        userId,
        shareToken: null,
      } satisfies DownloadZipJobData,
      {
        jobId: `zip-${job.id}`,
        attempts: 2,
        backoff: { type: 'exponential', delay: 10000 },
        removeOnComplete: true,
        removeOnFail: 50,
      },
    );

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

    // Enqueue
    await this.zipQueue.add(
      'create-zip',
      {
        jobId: job.id,
        userId: rootFolder.userId,
        shareToken,
      } satisfies DownloadZipJobData,
      {
        jobId: `zip-${job.id}`,
        attempts: 2,
        backoff: { type: 'exponential', delay: 10000 },
        removeOnComplete: true,
        removeOnFail: 50,
      },
    );

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
      downloadUrl: `/files/download-zip/${jobId}/file/${p.index ?? i}`,
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

  async serveZipPart(
    jobId: string,
    partIndex: number,
    res: Response,
  ): Promise<void> {
    const job = await this.prisma.downloadJob.findUnique({
      where: { id: jobId },
    });
    if (!job) throw new NotFoundException('Job not found');
    if (job.status !== 'ready')
      throw new BadRequestException('ZIP is not ready');
    if (job.expiresAt && job.expiresAt < new Date()) {
      throw new BadRequestException('Download link has expired');
    }

    const parts = (job.zipParts as unknown as ZipPart[]) || [];
    const part = parts.find((p) => (p.index ?? 0) === partIndex);
    if (!part) throw new NotFoundException('Part not found');

    // Track active stream
    this.activeStreams.set(jobId, (this.activeStreams.get(jobId) || 0) + 1);

    const partCount = parts.length;
    const d = job.createdAt;
    const pad = (n: number) => String(n).padStart(2, '0');
    const timestamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;

    const ext =
      partCount > 1
        ? `_part${String(partIndex + 1).padStart(2, '0')}.zip`
        : '.zip';
    const filename = `download_${timestamp}${ext}`;

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Length', String(part.size));
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

    try {
      const stream = await this.tempStorage.read(part.key);
      stream.pipe(res);

      await new Promise<void>((resolve, reject) => {
        res.on('finish', resolve);
        res.on('error', reject);
        stream.on('error', reject);
      });
    } finally {
      // Decrement active stream count
      const count = (this.activeStreams.get(jobId) || 1) - 1;
      if (count <= 0) this.activeStreams.delete(jobId);
      else this.activeStreams.set(jobId, count);
    }
  }

  hasActiveStreams(jobId: string): boolean {
    return (this.activeStreams.get(jobId) || 0) > 0;
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
