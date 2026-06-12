import {
  Injectable,
  Logger,
  NotFoundException,
  ConflictException,
  Inject,
} from '@nestjs/common';
import Redis from 'ioredis';
import { PrismaService } from '../prisma/prisma.service';
import { TelegramService } from '../telegram/telegram.service';
import { REDIS_CLIENT } from '../redis';
import { TEMP_STORAGE } from '../common/temp-storage';
import type { TempStorage } from '../common/temp-storage';

@Injectable()
export class FileLifecycleService {
  private readonly logger = new Logger(FileLifecycleService.name);
  private readonly deletionLocks = new Map<string, Promise<void>>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly telegram: TelegramService,
    @Inject(TEMP_STORAGE) private readonly tempStorage: TempStorage,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
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

    if (messages.length === 0) return;

    try {
      const transferUrl =
        process.env.TRANSFER_API_URL || 'http://backend-transfer:3001';
      const payload = messages.map((m) => ({
        telegramMessageId: m.messageId,
        botId: m.botId ? Number(m.botId) : 0,
      }));

      const res = await fetch(`${transferUrl}/internal/files/purge`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        this.logger.warn(`Failed to delegate purge: ${res.statusText}`);
      } else {
        this.logger.log(
          `Delegated purge of ${messages.length} messages to Go Transfer`,
        );
      }
    } catch (err) {
      this.logger.warn(
        `Failed to connect to Go Transfer for purging: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  async purgeTempFiles(
    files: Array<{
      tempStorageKey: string | null;
      chunks: Array<{ tempStorageKey: string | null }>;
    }>,
  ): Promise<void> {
    for (const file of files) {
      if (file.tempStorageKey) {
        await this.tempStorage.delete(file.tempStorageKey).catch(() => {});
      }
      for (const chunk of file.chunks) {
        if (chunk.tempStorageKey) {
          await this.tempStorage.delete(chunk.tempStorageKey).catch(() => {});
        }
      }
    }
  }

  async publishDeleteEvent(fileRecord: any) {
    if (process.env.ENABLE_EVENT_DRIVEN_DELETE !== 'true') {
      return this.legacyHttpPurge(fileRecord);
    }

    const telegramFileIds: string[] = [];
    if (fileRecord.telegramMessageId) {
      telegramFileIds.push(fileRecord.telegramMessageId.toString());
    }

    if (fileRecord.isChunked && fileRecord.chunks) {
      fileRecord.chunks.forEach(
        (chunk: { telegramMessageId: number | null }) => {
          if (chunk.telegramMessageId) {
            telegramFileIds.push(chunk.telegramMessageId.toString());
          }
        },
      );
    }

    const eventPayload = {
      fileId: fileRecord.id,
      telegramMessageIds: telegramFileIds,
      botId: Number(fileRecord.botId),
    };

    await this.redis.publish(
      'file:events',
      JSON.stringify({
        type: 'DELETE_FILE',
        payload: eventPayload,
      }),
    );

    this.logger.debug(`Published DELETE_FILE event for file ${fileRecord.id}`);
  }

  private async legacyHttpPurge(fileRecord: any) {
    await this.purgeFilesFromTelegram([fileRecord]);
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
    await this.purgeTempFiles([fileRecord]);

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

      await this.publishDeleteEvent(fileRecord);
      await this.purgeTempFiles([fileRecord]);

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

      for (const file of files) {
        await this.publishDeleteEvent(file);
      }
      await this.purgeTempFiles(files);

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

      for (const file of files) {
        await this.publishDeleteEvent(file);
      }
      await this.purgeTempFiles(files);

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
