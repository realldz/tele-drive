import {
  Injectable,
  Logger,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { TelegramService } from '../telegram/telegram.service';

@Injectable()
export class FileLifecycleService {
  private readonly logger = new Logger(FileLifecycleService.name);
  private readonly deletionLocks = new Map<string, Promise<void>>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly telegram: TelegramService,
  ) {}

  private async acquireDeletionLock(userId: string): Promise<() => void> {
    while (this.deletionLocks.has(userId)) {
      await this.deletionLocks.get(userId);
    }

    let releaseLock!: () => void;
    const lockPromise = new Promise<void>((resolve) => {
      releaseLock = () => {
        this.deletionLocks.delete(userId);
        resolve();
      };
    });
    this.deletionLocks.set(userId, lockPromise);
    return releaseLock;
  }

  async purgeFilesFromTelegram(
    files: Array<{
      telegramMessageId: number | null;
      chunks: Array<{
        telegramMessageId: number | null;
        botId?: bigint | null;
      }>;
      botId?: bigint | null;
    }>,
  ): Promise<void> {
    const messages: Array<{ messageId: number; botId?: bigint | null }> = [];

    for (const file of files) {
      if (file.telegramMessageId) {
        messages.push({ messageId: file.telegramMessageId, botId: file.botId });
      }
      for (const chunk of file.chunks) {
        if (chunk.telegramMessageId) {
          messages.push({
            messageId: chunk.telegramMessageId,
            botId: chunk.botId,
          });
        }
      }
    }

    for (const { messageId, botId } of messages) {
      try {
        await this.telegram.deleteMessage(messageId, botId ?? undefined);
        if (messages.length > 5) {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      } catch (err) {
        this.logger.warn(`Failed to delete Telegram message ${messageId}: ${err}`);
      }
    }
  }

  async delete(id: string, userId?: string) {
    const where: Record<string, unknown> = { id };
    if (userId) {
      where.userId = userId;
      where.deletedAt = null;
    }

    const fileRecord = await this.prisma.fileRecord.findFirst({
      where,
      include: { chunks: true },
    });
    if (!fileRecord) return;

    await this.purgeFilesFromTelegram([fileRecord]);

    await this.prisma.$transaction(async (tx) => {
      await tx.fileRecord.delete({ where: { id } });

      if (fileRecord.status === 'complete') {
        await tx.user.update({
          where: { id: fileRecord.userId },
          data: { usedSpace: { decrement: fileRecord.size } },
        });
      }
    });

    this.logger.log(
      `File deleted: "${fileRecord.filename}" (fileId: ${id}, chunks: ${fileRecord.chunks.length}, freed: ${fileRecord.size} bytes)`,
    );
  }

  async permanentDelete(id: string, userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { isCleaningTrash: true },
    });
    if (user?.isCleaningTrash) {
      throw new ConflictException('Trash cleanup is in progress');
    }

    const releaseLock = await this.acquireDeletionLock(userId);
    try {
      const fileRecord = await this.prisma.fileRecord.findFirst({
        where: { id, userId, deletedAt: { not: null } },
        include: { chunks: true },
      });
      if (!fileRecord) throw new NotFoundException('File not found in trash');

      await this.purgeFilesFromTelegram([fileRecord]);

      await this.prisma.$transaction(async (tx) => {
        await tx.fileRecord.delete({ where: { id } });

        if (fileRecord.status === 'complete') {
          await tx.user.update({
            where: { id: fileRecord.userId },
            data: { usedSpace: { decrement: fileRecord.size } },
          });
        }
      });

      this.logger.log(
        `File permanently deleted: "${fileRecord.filename}" (fileId: ${id}, freed: ${fileRecord.size} bytes)`,
      );
    } finally {
      releaseLock();
    }
  }

  async bulkPermanentDeleteFiles(fileIds: string[], userId: string) {
    if (fileIds.length === 0) return 0n;

    const releaseLock = await this.acquireDeletionLock(userId);
    try {
      const files = await this.prisma.fileRecord.findMany({
        where: { id: { in: fileIds }, userId },
        include: { chunks: true },
      });

      if (files.length === 0) return 0n;

      let freedSize = 0n;
      for (const file of files) {
        if (file.status === 'complete') {
          freedSize += file.size;
        }
      }

      await this.purgeFilesFromTelegram(files);

      await this.prisma.$transaction(async (tx) => {
        await tx.fileRecord.deleteMany({
          where: { id: { in: fileIds } },
        });

        if (freedSize > 0n) {
          await tx.user.update({
            where: { id: userId },
            data: { usedSpace: { decrement: freedSize } },
          });
        }
      });

      this.logger.log(
        `Bulk permanently deleted ${files.length} files, freed: ${freedSize} bytes`,
      );
      return freedSize;
    } finally {
      releaseLock();
    }
  }

  async emptyTrash(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { isCleaningTrash: true },
    });
    if (user?.isCleaningTrash) {
      throw new ConflictException('Trash cleanup is in progress');
    }

    const releaseLock = await this.acquireDeletionLock(userId);
    try {
      const files = await this.prisma.fileRecord.findMany({
        where: { userId, deletedAt: { not: null } },
        include: { chunks: true },
      });

      const folders = await this.prisma.folder.findMany({
        where: { userId, deletedAt: { not: null } },
        select: { id: true },
      });

      if (files.length === 0 && folders.length === 0) {
        return { success: true, count: 0, freedSize: 0 };
      }

      let freedSize = 0n;
      const fileIds = files.map((file) => file.id);
      const folderIds = folders.map((folder) => folder.id);

      for (const file of files) {
        if (file.status === 'complete') {
          freedSize += file.size;
        }
      }

      await this.purgeFilesFromTelegram(files);

      await this.prisma.$transaction(async (tx) => {
        if (fileIds.length > 0) {
          await tx.fileRecord.deleteMany({
            where: { id: { in: fileIds } },
          });
        }

        if (folderIds.length > 0) {
          await tx.folder.deleteMany({
            where: { id: { in: folderIds } },
          });
        }

        if (freedSize > 0n) {
          await tx.user.update({
            where: { id: userId },
            data: { usedSpace: { decrement: freedSize } },
          });
        }
      });

      this.logger.log(
        `Emptied trash for userId ${userId}: ${files.length} files, ${folders.length} folders, freed: ${freedSize} bytes`,
      );

      return {
        success: true,
        count: files.length + folders.length,
        freedSize: freedSize.toString(),
      };
    } finally {
      releaseLock();
    }
  }
}
