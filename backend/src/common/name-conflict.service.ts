import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export type ConflictAction = 'overwrite' | 'rename' | 'skip' | 'merge';

export interface ConflictCheckResult {
  hasConflict: boolean;
  existingItem?: {
    id: string;
    name: string;
    type: 'file' | 'folder';
  };
  suggestedName?: string;
}

@Injectable()
export class NameConflictService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Kiểm tra trùng tên file trong cùng thư mục.
   * Trả về fileRecord nếu có conflict, null nếu không.
   */
  async checkFileConflict(
    folderId: string | null,
    filename: string,
    userId: string,
    excludeFileId?: string,
  ): Promise<{ id: string; filename: string } | null> {
    const where: Record<string, unknown> = {
      folderId,
      userId,
      filename,
      deletedAt: null,
      ...(excludeFileId && { id: { not: excludeFileId } }),
    };

    const existing = await this.prisma.fileRecord.findFirst({
      where,
      select: { id: true, filename: true },
    });

    return existing;
  }

  /**
   * Kiểm tra trùng tên folder trong cùng parent.
   * Trả về folder nếu có conflict, null nếu không.
   */
  async checkFolderConflict(
    parentId: string | null,
    name: string,
    userId: string,
    excludeFolderId?: string,
  ): Promise<{ id: string; name: string } | null> {
    const where: Record<string, unknown> = {
      parentId,
      userId,
      name,
      deletedAt: null,
      ...(excludeFolderId && { id: { not: excludeFolderId } }),
    };

    const existing = await this.prisma.folder.findFirst({
      where,
      select: { id: true, name: true },
    });

    return existing;
  }

  /**
   * Sinh tên duy nhất theo pattern: file (1).ext, file (2).ext, ...
   */
  generateUniqueName(name: string, existingNames: string[]): string {
    const nameSet = new Set(existingNames);

    if (!nameSet.has(name)) {
      return name;
    }

    const lastDotIndex = name.lastIndexOf('.');
    const baseName = lastDotIndex > 0 ? name.substring(0, lastDotIndex) : name;
    const extension = lastDotIndex > 0 ? name.substring(lastDotIndex) : '';

    let counter = 1;
    let uniqueName: string;

    do {
      uniqueName = `${baseName} (${counter})${extension}`;
      counter++;
    } while (nameSet.has(uniqueName));

    return uniqueName;
  }

  /**
   * Merge nội dung của source folder vào target folder (shallow merge).
   * - File cùng tên: auto-rename
   * - File khác tên: giữ nguyên
   * - Folder cùng tên: merge đệ quy (cũng shallow)
   * - Folder khác tên: giữ nguyên
   */
  async mergeFolderContents(
    sourceFolderId: string,
    targetFolderId: string,
    userId: string,
  ): Promise<void> {
    // Lấy tất cả files và folders trong 2 folder
    const [sourceFiles, targetFiles, sourceFolders, targetFolders] =
      await Promise.all([
        this.prisma.fileRecord.findMany({
          where: { folderId: sourceFolderId, userId, deletedAt: null },
          select: { id: true, filename: true },
        }),
        this.prisma.fileRecord.findMany({
          where: { folderId: targetFolderId, userId, deletedAt: null },
          select: { filename: true },
        }),
        this.prisma.folder.findMany({
          where: { parentId: sourceFolderId, userId, deletedAt: null },
          select: { id: true, name: true },
        }),
        this.prisma.folder.findMany({
          where: { parentId: targetFolderId, userId, deletedAt: null },
          select: { name: true },
        }),
      ]);

    const targetFileNames = targetFiles.map((f) => f.filename);
    const targetFolderNames = targetFolders.map((f) => f.name);

    // Merge files — auto-rename nếu trùng
    for (const file of sourceFiles) {
      const uniqueName = this.generateUniqueName(
        file.filename,
        targetFileNames,
      );
      if (uniqueName !== file.filename) {
        await this.prisma.fileRecord.update({
          where: { id: file.id },
          data: { filename: uniqueName, folderId: targetFolderId },
        });
        targetFileNames.push(uniqueName);
      } else {
        await this.prisma.fileRecord.update({
          where: { id: file.id },
          data: { folderId: targetFolderId },
        });
      }
    }

    // Merge folders — recurse vào folder cùng tên hoặc move folder khác tên
    for (const folder of sourceFolders) {
      const existingTarget = targetFolders.find((f) => f.name === folder.name);
      if (existingTarget) {
        // Tìm folder target có cùng tên
        const targetFolder = await this.prisma.folder.findFirst({
          where: {
            parentId: targetFolderId,
            name: folder.name,
            userId,
            deletedAt: null,
          },
          select: { id: true },
        });
        if (targetFolder) {
          // Merge đệ quy
          await this.mergeFolderContents(folder.id, targetFolder.id, userId);
          // Xoá source folder (sau khi đã move hết nội dung)
          await this.prisma.folder.delete({ where: { id: folder.id } });
        }
      } else {
        // Move folder vào target
        await this.prisma.folder.update({
          where: { id: folder.id },
          data: { parentId: targetFolderId },
        });
        targetFolderNames.push(folder.name);
      }
    }
  }

  /**
   * Kiểm tra tất cả tên files/folders hiện có trong một thư mục.
   * Dùng để sinh unique name khi restore hoặc create.
   */
  async getExistingNames(
    folderId: string | null,
    userId: string,
  ): Promise<string[]> {
    const [files, folders] = await Promise.all([
      this.prisma.fileRecord.findMany({
        where: { folderId, userId, deletedAt: null },
        select: { filename: true },
      }),
      this.prisma.folder.findMany({
        where: { parentId: folderId, userId, deletedAt: null },
        select: { name: true },
      }),
    ]);

    return [...files.map((f) => f.filename), ...folders.map((f) => f.name)];
  }

  /**
   * Kiểm tra conflict và trả về suggested action.
   */
  async checkConflictAndSuggest(
    type: 'file' | 'folder',
    folderId: string | null,
    name: string,
    userId: string,
    excludeId?: string,
  ): Promise<ConflictCheckResult> {
    if (type === 'file') {
      const existing = await this.checkFileConflict(
        folderId,
        name,
        userId,
        excludeId,
      );
      if (existing) {
        const existingNames = await this.getExistingNames(folderId, userId);
        return {
          hasConflict: true,
          existingItem: {
            id: existing.id,
            name: existing.filename,
            type: 'file',
          },
          suggestedName: this.generateUniqueName(name, existingNames),
        };
      }
    } else {
      const existing = await this.checkFolderConflict(
        folderId,
        name,
        userId,
        excludeId,
      );
      if (existing) {
        const existingNames = await this.getExistingNames(folderId, userId);
        return {
          hasConflict: true,
          existingItem: {
            id: existing.id,
            name: existing.name,
            type: 'folder',
          },
          suggestedName: this.generateUniqueName(name, existingNames),
        };
      }
    }

    return { hasConflict: false };
  }
}
