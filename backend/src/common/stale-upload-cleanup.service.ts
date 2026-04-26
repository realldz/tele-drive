import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { TelegramService } from '../telegram/telegram.service';

@Injectable()
export class StaleUploadCleanupService {
  private readonly logger = new Logger(StaleUploadCleanupService.name);

  /** Uploads older than this (ms) are considered stale */
  private readonly STALE_THRESHOLD_MS = 60 * 60 * 1000; // 1 hour

  constructor(
    private readonly prisma: PrismaService,
    private readonly telegram: TelegramService,
  ) {}

  @Cron('0 */6 * * *') // Every 6 hours
  async handleStaleUploadCleanup() {
    this.logger.log('Starting stale upload cleanup...');

    const cutoff = new Date(Date.now() - this.STALE_THRESHOLD_MS);

    const staleUploads = await this.prisma.fileRecord.findMany({
      where: {
        status: { in: ['uploading', 'aborted'] },
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
        // Delete chunks from Telegram
        for (const chunk of file.chunks) {
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
      } catch (err) {
        this.logger.error(`Failed to clean stale upload ${file.id}: ${err}`);
      }
    }

    this.logger.log(
      `Stale upload cleanup completed: ${cleaned}/${staleUploads.length} cleaned.`,
    );
  }
}
