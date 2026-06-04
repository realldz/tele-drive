import { Controller, Get, Post, UseGuards, Inject } from '@nestjs/common';
import { AdminGuard } from '../auth/admin.guard';
import { PrismaService } from '../prisma/prisma.service';
import { TEMP_STORAGE } from '../common/temp-storage';
import type { TempStorage } from '../common/temp-storage';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';

@UseGuards(AdminGuard)
@Controller('admin')
export class AdminBufferController {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(TEMP_STORAGE) private readonly tempStorage: TempStorage,
    @InjectQueue('upload-dispatch') private readonly uploadQueue: Queue,
  ) {}

  @Get('buffer-stats')
  async getBufferStats() {
    const [bufferedCount, failedCount, bufferedFiles] = await Promise.all([
      this.prisma.fileRecord.count({ where: { status: 'buffered' } }),
      this.prisma.fileRecord.count({ where: { status: 'buffer_failed' } }),
      this.prisma.fileRecord.findMany({
        where: { status: 'buffered' },
        orderBy: { createdAt: 'asc' },
        take: 1,
        select: { createdAt: true },
      }),
    ]);

    const tempStorageUsed = await this.tempStorage.getUsedBytes();
    const oldestAge = bufferedFiles[0]
      ? Date.now() - bufferedFiles[0].createdAt.getTime()
      : 0;

    const jobCounts = await this.uploadQueue.getJobCounts(
      'waiting',
      'active',
      'delayed',
      'failed',
    );

    return {
      bufferedCount,
      failedCount,
      tempStorageUsedBytes: tempStorageUsed.toString(),
      oldestBufferedAgeMs: oldestAge,
      queue: jobCounts,
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
}
