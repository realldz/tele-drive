import {
  Controller,
  Get,
  Post,
  Delete,
  UseGuards,
  Inject,
  Logger,
} from '@nestjs/common';
import { AdminGuard } from '../auth/admin.guard';
import { PrismaService } from '../prisma/prisma.service';
import { TEMP_STORAGE } from '../common/temp-storage';
import type { TempStorage } from '../common/temp-storage';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { HttpService } from '@nestjs/axios';
import * as fs from 'fs';
import * as path from 'path';

@UseGuards(AdminGuard)
@Controller('admin')
export class AdminSystemController {
  private readonly logger = new Logger(AdminSystemController.name);
  private readonly zipBaseDir: string;
  constructor(
    private readonly prisma: PrismaService,
    @Inject(TEMP_STORAGE) private readonly tempStorage: TempStorage,
    @InjectQueue('upload-dispatch') private readonly uploadQueue: Queue,
    private readonly httpService: HttpService,
  ) {
    this.zipBaseDir = path.join(
      process.env.UPLOAD_BUFFER_DIR || './.upload-buffer',
      'zip',
    );
  }

  private async getDirSize(dirPath: string): Promise<bigint> {
    let size = 0n;
    try {
      const entries = await fs.promises.readdir(dirPath, {
        withFileTypes: true,
      });
      for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name);
        if (entry.isDirectory()) {
          size += await this.getDirSize(fullPath);
        } else if (entry.isFile()) {
          const stats = await fs.promises.stat(fullPath);
          size += BigInt(stats.size);
        }
      }
    } catch {
      // Ignore errors if dir doesn't exist
    }
    return size;
  }

  @Get('system-stats')
  async getSystemStats() {
    const [
      bufferedCount,
      failedCount,
      bufferedFiles,
      zipActiveCount,
      zipReadyCount,
      zipFailedCount,
    ] = await Promise.all([
      this.prisma.fileRecord.count({ where: { status: 'buffered' } }),
      this.prisma.fileRecord.count({ where: { status: 'buffer_failed' } }),
      this.prisma.fileRecord.findMany({
        where: { status: 'buffered' },
        orderBy: { createdAt: 'asc' },
        take: 1,
        select: { createdAt: true },
      }),
      this.prisma.downloadJob.count({
        where: { status: { in: ['collecting', 'zipping', 'splitting'] } },
      }),
      this.prisma.downloadJob.count({ where: { status: 'ready' } }),
      this.prisma.downloadJob.count({ where: { status: 'failed' } }),
    ]);

    const tempStorageUsed = await this.tempStorage.getUsedBytes();
    const zipTempStorageUsed = await this.getDirSize(this.zipBaseDir);
    const oldestAge = bufferedFiles[0]
      ? Date.now() - bufferedFiles[0].createdAt.getTime()
      : 0;

    let jobCounts: Record<string, number> = {};
    try {
      jobCounts = await this.uploadQueue.getJobCounts(
        'waiting',
        'active',
        'delayed',
        'failed',
      );
    } catch (err) {
      this.logger.warn('Failed to get BullMQ job counts, returning empty', err);
    }

    // Fetch Go transfer service stats
    let goStats: Record<string, unknown> | null = null;
    try {
      const goRes = await this.httpService.axiosRef.get(
        'http://backend-transfer:3001/v1/transfer/stats',
        { timeout: 5000 },
      );
      goStats = goRes.data;
    } catch {
      this.logger.warn('Failed to fetch Go transfer service stats');
    }

    // NestJS process metrics
    const memUsage = process.memoryUsage();
    const nestjsStats = {
      uptime: Math.floor(process.uptime()),
      memoryRss: memUsage.rss.toString(),
      memoryHeapUsed: memUsage.heapUsed.toString(),
      memoryHeapTotal: memUsage.heapTotal.toString(),
    };

    return {
      buffer: {
        bufferedCount,
        failedCount,
        tempStorageUsedBytes: tempStorageUsed.toString(),
        oldestBufferedAgeMs: oldestAge,
        queue: jobCounts,
      },
      zip: {
        activeCount: zipActiveCount,
        readyCount: zipReadyCount,
        failedCount: zipFailedCount,
        tempStorageUsedBytes: zipTempStorageUsed.toString(),
      },
      go: goStats,
      nestjs: nestjsStats,
    };
  }

  @Post('buffer-retry')
  async retryFailedBuffers() {
    const failedFiles = await this.prisma.fileRecord.findMany({
      where: { status: 'buffer_failed' },
    });

    if (failedFiles.length === 0) {
      return { retriedCount: 0 };
    }

    const failedFileIds = failedFiles.map((f) => f.id);

    await this.prisma.fileRecord.updateMany({
      where: { id: { in: failedFileIds } },
      data: { status: 'buffered', bufferRetries: 0 },
    });

    let retriedCount = 0;

    for (const file of failedFiles) {
      if (!file.isChunked) {
        if (file.tempStorageKey) {
          await this.uploadQueue
            .add(
              'dispatch-file',
              {
                type: 'file',
                recordId: file.id,
                tempStorageKey: file.tempStorageKey,
                userId: file.userId,
              },
              {
                jobId: `file-${file.id}`,
                attempts: 3,
                backoff: { type: 'exponential', delay: 5000 },
                removeOnComplete: true,
                removeOnFail: 100,
              },
            )
            .catch(() => {});
          retriedCount++;
        }
      } else {
        const chunks = await this.prisma.fileChunk.findMany({
          where: { fileId: file.id, status: 'buffered' },
        });

        for (const chunk of chunks) {
          if (chunk.tempStorageKey) {
            await this.uploadQueue
              .add(
                'dispatch-chunk',
                {
                  type: 'chunk',
                  chunkId: chunk.id,
                  fileRecordId: file.id,
                  chunkIndex: chunk.chunkIndex,
                  tempStorageKey: chunk.tempStorageKey,
                  userId: file.userId,
                },
                {
                  jobId: `chunk-${chunk.id}`,
                  attempts: 3,
                  backoff: { type: 'exponential', delay: 5000 },
                  removeOnComplete: true,
                  removeOnFail: 100,
                },
              )
              .catch(() => {});
            retriedCount++;
          }
        }
      }
    }

    return { retriedCount };
  }

  @Delete('zip-failed-jobs')
  async clearFailedZips() {
    const result = await this.prisma.downloadJob.deleteMany({
      where: { status: 'failed' },
    });
    return { deletedCount: result.count };
  }
}
