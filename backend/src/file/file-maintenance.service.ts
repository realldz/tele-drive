import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { TelegramService } from '../telegram/telegram.service';

@Injectable()
export class FileMaintenanceService {
  private readonly logger = new Logger(FileMaintenanceService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly telegram: TelegramService,
  ) {}

  async reindexUnavailableBots(): Promise<{
    recovered: number;
    failed: number;
  }> {
    const availableIds = this.telegram.availableBotIds;

    const staleChunks = await this.prisma.fileChunk.findMany({
      where: { botId: { notIn: availableIds } },
    });
    const staleFiles = await this.prisma.fileRecord.findMany({
      where: {
        isChunked: false,
        telegramMessageId: { not: null },
        botId: { notIn: availableIds },
      },
    });

    let recovered = 0;
    let failed = 0;

    for (const chunk of staleChunks) {
      try {
        if (!chunk.telegramMessageId) {
          failed++;
          continue;
        }
        const { fileId, botId } = await this.telegram.recoverFileId(
          chunk.telegramMessageId,
        );
        await this.prisma.fileChunk.update({
          where: { id: chunk.id },
          data: { telegramFileId: fileId, botId },
        });
        recovered++;
      } catch {
        failed++;
      }
    }

    for (const file of staleFiles) {
      try {
        if (!file.telegramMessageId) {
          failed++;
          continue;
        }
        const { fileId, botId } = await this.telegram.recoverFileId(
          file.telegramMessageId,
        );
        await this.prisma.fileRecord.update({
          where: { id: file.id },
          data: { telegramFileId: fileId, botId },
        });
        recovered++;
      } catch {
        failed++;
      }
    }

    this.logger.log(
      `Reindex complete: ${recovered} recovered, ${failed} failed`,
    );
    return { recovered, failed };
  }
}
