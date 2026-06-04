import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { TelegramService } from '../telegram/telegram.service';
import { TEMP_STORAGE } from './temp-storage';
import type { TempStorage } from './temp-storage';

@Injectable()
export class StaleUploadCleanupService {
  private readonly logger = new Logger(StaleUploadCleanupService.name);

  /** Uploads older than this (ms) are considered stale */
  private readonly STALE_THRESHOLD_MS = 60 * 60 * 1000; // 1 hour

  constructor(
    private readonly prisma: PrismaService,
    private readonly telegram: TelegramService,
    @Inject(TEMP_STORAGE) private readonly tempStorage: TempStorage,
  ) {}

  @Cron('0 */6 * * *') // Every 6 hours
  async handleStaleUploadCleanup() {
    this.logger.log('Starting stale upload cleanup...');

    const cutoff = new Date(Date.now() - this.STALE_THRESHOLD_MS);

    const staleUploads = await this.prisma.fileRecord.findMany({
      where: {
        status: { in: ['uploading', 'aborted', 'buffer_failed'] },
        updatedAt: { lt: cutoff },
      },
      include: { chunks: true },
    });

    if (staleUploads.length === 0) {
      this.logger.log('No stale uploads found.');
      return;
    }

    let cleaned = 0;
    for (const file of staleUploads) {
      try {
        // Delete buffered files from temp storage
        if (file.tempStorageKey) {
          await this.tempStorage.delete(file.tempStorageKey).catch(() => {});
        }

        // Delete chunks from Telegram and temp storage
        for (const chunk of file.chunks) {
          if (chunk.tempStorageKey) {
            await this.tempStorage.delete(chunk.tempStorageKey).catch(() => {});
          }
          if (chunk.telegramMessageId) {
            try {
              await this.telegram.deleteMessage(
                chunk.telegramMessageId,
                chunk.botId,
              );
            } catch {
              // Chunk may already be deleted, continue
            }
          }
        }

        // Delete non-chunked file from Telegram
        if (file.telegramMessageId) {
          try {
            await this.telegram.deleteMessage(
              file.telegramMessageId,
              file.botId,
            );
          } catch {
            // Message may already be deleted
          }
        }

        // Delete DB record (cascade deletes FileChunks)
        await this.prisma.fileRecord.delete({ where: { id: file.id } });

        cleaned++;
        this.logger.log(
          `Cleaned stale upload: "${file.filename}" (id: ${file.id}, chunks: ${file.chunks.length})`,
        );
      } catch (err: unknown) {
        this.logger.error(
          `Failed to clean stale upload ${file.id}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    this.logger.log(
      `Stale upload cleanup completed: ${cleaned}/${staleUploads.length} cleaned.`,
    );
  }
}
