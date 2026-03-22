import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { TelegramService } from '../telegram/telegram.service';

/**
 * TrashCleanupService — Cron job dọn dẹp thùng rác tự động.
 *
 * Chạy mỗi ngày lúc 2:00 AM:
 *   - Tìm tất cả FileRecord và Folder có deletedAt < (now - 7 ngày)
 *   - Thực hiện permanent delete (xoá trên Telegram + DB + hoàn trả usedSpace)
 */
@Injectable()
export class TrashCleanupService {
  private readonly logger = new Logger(TrashCleanupService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly telegram: TelegramService,
  ) {}

  @Cron('0 2 * * *') // Mỗi ngày lúc 2:00 AM
  async handleTrashCleanup() {
    this.logger.log('Starting trash cleanup job...');

    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - 7);

    // 1. Xoá vĩnh viễn files quá 7 ngày trong thùng rác
    const expiredFiles = await this.prisma.fileRecord.findMany({
      where: {
        deletedAt: { not: null, lt: cutoffDate },
      },
      include: { chunks: true },
    });

    let filesDeleted = 0;
    for (const file of expiredFiles) {
      try {
        // Xoá trên Telegram
        if (file.telegramMessageId) {
          await this.telegram.deleteMessage(file.telegramMessageId);
        }
        for (const chunk of file.chunks) {
          if (chunk.telegramMessageId) {
            await this.telegram.deleteMessage(chunk.telegramMessageId);
          }
        }

        // Transaction: xoá DB + trừ usedSpace
        await this.prisma.$transaction(async (tx) => {
          await tx.fileRecord.delete({ where: { id: file.id } });

          if (file.status === 'complete') {
            await tx.user.update({
              where: { id: file.userId },
              data: { usedSpace: { decrement: file.size } },
            });
          }
        });

        filesDeleted++;
      } catch (err) {
        this.logger.error(`Failed to permanently delete file ${file.id}: ${err}`);
      }
    }

    // 2. Xoá vĩnh viễn folders quá 7 ngày (chỉ folder, files đã xoá ở trên)
    const expiredFolders = await this.prisma.folder.findMany({
      where: {
        deletedAt: { not: null, lt: cutoffDate },
      },
      select: { id: true, name: true },
    });

    let foldersDeleted = 0;
    for (const folder of expiredFolders) {
      try {
        // Kiểm tra folder còn tồn tại (có thể đã bị cascade delete)
        const exists = await this.prisma.folder.findUnique({
          where: { id: folder.id },
        });
        if (!exists) continue;

        await this.prisma.folder.delete({ where: { id: folder.id } });
        foldersDeleted++;
      } catch (err) {
        this.logger.error(`Failed to permanently delete folder ${folder.id}: ${err}`);
      }
    }

    this.logger.log(
      `Trash cleanup completed: ${filesDeleted} files, ${foldersDeleted} folders permanently deleted`,
    );
  }
}
