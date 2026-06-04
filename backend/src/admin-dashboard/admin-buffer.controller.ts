import { Controller, Get, Post, UseGuards, Inject } from '@nestjs/common';
import { AdminGuard } from '../auth/admin.guard';
import { PrismaService } from '../prisma/prisma.service';
import { TEMP_STORAGE } from '../common/temp-storage';
import type { TempStorage } from '../common/temp-storage';

@UseGuards(AdminGuard)
@Controller('admin')
export class AdminBufferController {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(TEMP_STORAGE) private readonly tempStorage: TempStorage,
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

    return {
      bufferedCount,
      failedCount,
      tempStorageUsedBytes: tempStorageUsed.toString(),
      oldestBufferedAgeMs: oldestAge,
    };
  }

  @Post('buffer-retry')
  async retryFailedBuffers() {
    const result = await this.prisma.fileRecord.updateMany({
      where: { status: 'buffer_failed' },
      data: { status: 'buffered', bufferRetries: 0 },
    });
    return { retriedCount: result.count };
  }
}
