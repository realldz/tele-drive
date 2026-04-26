import {
  Injectable,
  Logger,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { PaginationQueryDto } from '../common/dto/pagination-query.dto';
import { PaginatedResponse } from '../common/types/paginated-response.type';
import {
  NameConflictService,
  ConflictAction,
} from '../common/name-conflict.service';
import * as crypto from 'crypto';

@Injectable()
export class FileMetadataService {
  private readonly logger = new Logger(FileMetadataService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly nameConflictService: NameConflictService,
  ) {}

  async getFileInfo(id: string, userId: string) {
    const fileRecord = await this.prisma.fileRecord.findFirst({
      where: { id, userId, deletedAt: null },
      select: {
        id: true,
        filename: true,
        size: true,
        mimeType: true,
        createdAt: true,
      },
    });
    if (!fileRecord) throw new NotFoundException('File not found');
    return fileRecord;
  }

  async getSharedFileInfo(token: string) {
    const fileRecord = await this.prisma.fileRecord.findUnique({
      where: { shareToken: token },
      select: {
        id: true,
        filename: true,
        size: true,
        mimeType: true,
        createdAt: true,
        user: { select: { username: true } },
      },
    });
    if (!fileRecord) throw new NotFoundException('Shared file not found');

    return fileRecord;
  }

  async rename(id: string, newName: string, userId: string) {
    const fileRecord = await this.prisma.fileRecord.findFirst({
      where: { id, userId, deletedAt: null },
      select: { id: true, filename: true, folderId: true },
    });
    if (!fileRecord) throw new NotFoundException('File not found');

    const conflict = await this.nameConflictService.checkFileConflict(
      fileRecord.folderId,
      newName,
      userId,
      id,
    );
    if (conflict) {
      throw new ConflictException({
        message:
          'A file or folder with this name already exists in the current folder',
        type: 'file' as const,
      });
    }

    const updated = await this.prisma.fileRecord.update({
      where: { id },
      data: { filename: newName },
    });

    this.logger.log(
      `File renamed: "${fileRecord.filename}" to "${newName}" (fileId: ${id})`,
    );
    return updated;
  }

  async move(
    id: string,
    newFolderId: string | null,
    userId: string,
    conflictAction?: ConflictAction,
  ) {
    const fileRecord = await this.prisma.fileRecord.findFirst({
      where: { id, userId, deletedAt: null },
      select: { id: true, filename: true, folderId: true },
    });
    if (!fileRecord) throw new NotFoundException('File not found');

    if (newFolderId) {
      const folder = await this.prisma.folder.findFirst({
        where: { id: newFolderId, userId, deletedAt: null },
        select: { id: true },
      });
      if (!folder) throw new NotFoundException('Destination folder not found');
    }

    const conflict = await this.nameConflictService.checkFileConflict(
      newFolderId,
      fileRecord.filename,
      userId,
      id,
    );

    if (conflict) {
      if (!conflictAction || conflictAction === 'skip') {
        throw new ConflictException({
          message:
            'A file or folder with this name already exists in the destination folder',
          type: 'file' as const,
          id: conflict.id,
          name: conflict.filename,
          suggestedName: await this.nameConflictService.generateUniqueName(
            fileRecord.filename,
            await this.nameConflictService.getExistingNames(newFolderId, userId),
          ),
        });
      }

      if (conflictAction === 'overwrite') {
        await this.prisma.fileRecord.update({
          where: { id: conflict.id },
          data: { deletedAt: new Date() },
        });
        this.logger.log(
          `File overwrite during move: "${conflict.filename}" (id: ${conflict.id}) soft-deleted`,
        );
      }

      if (conflictAction === 'rename') {
        const existingNames = await this.nameConflictService.getExistingNames(
          newFolderId,
          userId,
        );
        const uniqueName = this.nameConflictService.generateUniqueName(
          fileRecord.filename,
          existingNames,
        );
        await this.prisma.fileRecord.update({
          where: { id },
          data: { filename: uniqueName },
        });
        this.logger.log(
          `File auto-renamed during move: "${fileRecord.filename}" to "${uniqueName}" (fileId: ${id})`,
        );
      }
    }

    const updated = await this.prisma.fileRecord.update({
      where: { id },
      data: { folderId: newFolderId },
    });

    this.logger.log(
      `File moved: "${fileRecord.filename}" (fileId: ${id}) to folder: ${newFolderId || 'root'}`,
    );
    return updated;
  }

  async share(id: string, userId: string) {
    const fileRecord = await this.prisma.fileRecord.findFirst({
      where: { id, userId, deletedAt: null },
    });
    if (!fileRecord) throw new NotFoundException('File not found');

    const shareToken = fileRecord.shareToken || crypto.randomBytes(16).toString('hex');
    const updated = await this.prisma.fileRecord.update({
      where: { id },
      data: {
        visibility: 'PUBLIC_LINK',
        shareToken,
      },
    });

    this.logger.log(
      `File shared: "${fileRecord.filename}" (fileId: ${id}, token: ${shareToken})`,
    );
    return updated;
  }

  async unshare(id: string, userId: string) {
    const fileRecord = await this.prisma.fileRecord.findFirst({
      where: { id, userId, deletedAt: null },
    });
    if (!fileRecord) throw new NotFoundException('File not found');

    const updated = await this.prisma.fileRecord.update({
      where: { id },
      data: {
        visibility: 'PRIVATE',
        shareToken: null,
      },
    });

    this.logger.log(`File unshared: "${fileRecord.filename}" (fileId: ${id})`);
    return updated;
  }

  async softDelete(id: string, userId: string) {
    const fileRecord = await this.prisma.fileRecord.findFirst({
      where: { id, userId, deletedAt: null },
    });
    if (!fileRecord) throw new NotFoundException('File not found');

    const updated = await this.prisma.fileRecord.update({
      where: { id },
      data: { deletedAt: new Date() },
    });

    this.logger.log(
      `File soft-deleted: "${fileRecord.filename}" (fileId: ${id}, userId: ${userId})`,
    );
    return updated;
  }

  async restore(
    id: string,
    userId: string,
  ): Promise<{ file: { id: string; filename: string }; autoRenamed: boolean }> {
    const fileRecord = await this.prisma.fileRecord.findFirst({
      where: { id, userId, deletedAt: { not: null } },
    });
    if (!fileRecord) throw new NotFoundException('File not found in trash');

    const conflict = await this.nameConflictService.checkFileConflict(
      fileRecord.folderId,
      fileRecord.filename,
      userId,
      id,
    );

    let autoRenamed = false;
    let finalFilename = fileRecord.filename;
    if (conflict) {
      const existingNames = await this.nameConflictService.getExistingNames(
        fileRecord.folderId,
        userId,
      );
      finalFilename = this.nameConflictService.generateUniqueName(
        fileRecord.filename,
        existingNames,
      );
      autoRenamed = true;
      this.logger.log(
        `File restore auto-renamed: "${fileRecord.filename}" to "${finalFilename}" (fileId: ${id})`,
      );
    }

    const updated = await this.prisma.fileRecord.update({
      where: { id },
      data: {
        deletedAt: null,
        ...(autoRenamed && { filename: finalFilename }),
      },
    });

    this.logger.log(
      `File restored: "${updated.filename}" (fileId: ${id}, userId: ${userId})`,
    );
    return { file: updated, autoRenamed };
  }

  async listTrash(
    userId: string,
    pagination: PaginationQueryDto,
  ): Promise<PaginatedResponse<unknown>> {
    const limit = pagination.limit ?? 20;
    const where: Record<string, unknown> = {
      userId,
      deletedAt: { not: null },
      OR: [{ folderId: null }, { folder: { deletedAt: null } }],
    };

    if (pagination.search) {
      where.filename = { contains: pagination.search, mode: 'insensitive' };
    }

    if (pagination.cursor) {
      try {
        const decoded = Buffer.from(pagination.cursor, 'base64').toString('utf-8');
        const [timestamp, cursorId] = decoded.split('_');
        where.OR = [
          { deletedAt: { lt: new Date(timestamp) } },
          { deletedAt: new Date(timestamp), id: { lt: cursorId } },
        ];
      } catch {
        // Ignore invalid cursor
      }
    }

    const data = await this.prisma.fileRecord.findMany({
      where,
      orderBy: [{ deletedAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      select: {
        id: true,
        filename: true,
        size: true,
        mimeType: true,
        deletedAt: true,
        createdAt: true,
        folderId: true,
        userId: true,
      },
    });

    const hasNext = data.length > limit;
    const items = hasNext ? data.slice(0, -1) : data;
    const nextCursor = hasNext
      ? Buffer.from(
          `${(items[items.length - 1] as { deletedAt: Date }).deletedAt.toISOString()}_${(items[items.length - 1] as { id: string }).id}`,
        ).toString('base64')
      : null;

    const total = await this.prisma.fileRecord.count({ where });

    return { data: items, nextCursor, total };
  }
}
