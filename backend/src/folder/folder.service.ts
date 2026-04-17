import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { FileService } from '../file/file.service';
import { CryptoService } from '../crypto/crypto.service';
import { NameConflictService } from '../common/name-conflict.service';
import { PaginationQueryDto } from '../common/dto/pagination-query.dto';
import { PaginatedResponse } from '../common/types/paginated-response.type';
import { PaginatedFolderContent } from '../common/types/paginated-folder-content.type';
import type { ConflictAction } from '../common/name-conflict.service';
import * as crypto from 'crypto';
import { message } from 'telegraf/filters';

@Injectable()
export class FolderService {
  private readonly logger = new Logger(FolderService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly fileService: FileService,
    private readonly cryptoService: CryptoService,
    private readonly nameConflictService: NameConflictService,
  ) { }

  /**
   * Tạo folder mới — userId lấy từ JWT
   */
  async create(
    name: string,
    userId: string,
    parentId?: string,
    conflictAction?: ConflictAction,
  ) {
    // Nếu có parentId, kiểm tra folder cha thuộc về user
    if (parentId) {
      const parentFolder = await this.prisma.folder.findFirst({
        where: { id: parentId, userId, deletedAt: null },
      });
      if (!parentFolder) throw new NotFoundException('Parent folder not found');
    }

    // Check name conflict at parent
    const conflict = await this.nameConflictService.checkFolderConflict(
      parentId || null,
      name,
      userId,
    );

    if (conflict) {
      if (!conflictAction || conflictAction === 'skip') {
        throw new ConflictException({
          message:
            'A file or folder with this name already exists in the current folder',
          type: 'folder' as const,
          id: conflict.id,
          name: conflict.name,
        });
      }

      if (conflictAction === 'merge') {
        // Trộn nội dung vào folder có sẵn (dùng create folder làm source rỗng,
        // thực tế là upload files mới vào folder conflict — nhưng vì create chỉ tạo folder,
        // ta coi như "merge" nghĩa là không tạo folder mới, trả về folder cũ).
        // Tuy nhiên, nếu caller muốn tạo folder mới để chứa files upload kèm →
        // ta auto-rename folder mới.
        // Theo design: merge = dùng folder cũ, không tạo mới.
        this.logger.log(
          `Folder create merged into existing: "${name}" into "${conflict.name}" (id: ${conflict.id})`,
        );
        return conflict;
      }
    }

    const folder = await this.prisma.folder.create({
      data: {
        name,
        parentId,
        userId,
      },
    });

    this.logger.log(
      `Folder created: "${name}" (id: ${folder.id}, parentId: ${parentId || 'root'}, userId: ${userId})`,
    );
    return folder;
  }

  /**
   * Danh sách folders — scope theo userId, ẩn soft-deleted
   */
  async findAll(userId: string, parentId?: string) {
    return this.prisma.folder.findMany({
      where: { parentId: parentId || null, userId, deletedAt: null },
      select: {
        id: true,
        name: true,
        parentId: true,
        userId: true,
        visibility: true,
        shareToken: true,
        createdAt: true,
        updatedAt: true,
        children: {
          where: { deletedAt: null },
          select: { id: true, name: true },
        },
        files: {
          where: { deletedAt: null },
          select: { id: true, filename: true },
        },
      },
    });
  }

  /**
   * Lấy nội dung folder (folders + files) — scope theo userId, ẩn soft-deleted
   * Hỗ trợ pagination với cursor riêng cho folders và files
   */
  async getContent(
    userId: string,
    folderId: string | undefined,
    pagination: PaginationQueryDto,
  ): Promise<PaginatedFolderContent> {
    const limit = pagination.limit ?? 50;
    const parentWhere: Record<string, unknown> = {
      parentId: folderId || null,
      userId,
      deletedAt: null,
    };
    const filesWhere: Record<string, unknown> = {
      folderId: folderId || null,
      userId,
      status: { in: ['complete', 'uploading'] as const },
      deletedAt: null,
    };

    // Apply search
    if (pagination.search) {
      parentWhere['name'] = {
        contains: pagination.search,
        mode: 'insensitive' as const,
      };
      (filesWhere as Record<string, unknown>)['filename'] = {
        contains: pagination.search,
        mode: 'insensitive' as const,
      };
    }

    // Parse folder cursor
    let isQueryNextFolder = false;
    const fileWhere: Record<string, unknown> = { ...filesWhere };
    if (pagination.cursor) {
      try {
        const parsed = JSON.parse(
          Buffer.from(pagination.cursor, 'base64').toString('utf-8'),
        );
        if (parsed.f) {
          (parentWhere as Record<string, unknown>)['id'] = { lt: parsed.f };
          isQueryNextFolder = true;
        }
        // Parse file cursor (base64 JSON with "fc" key)
        if (parsed.fc) {
          const [timestamp, id] = parsed.fc.split('_');
          fileWhere.OR = [
            { createdAt: { lt: new Date(timestamp) } },
            { createdAt: new Date(timestamp), id: { lt: id } },
          ];
        }
      } catch {
        // Invalid cursor, ignore
      }
    }

    // Determine if cursor is a file-only cursor (has fc but no f)
    let isQueryNextFile = false;
    if (pagination.cursor) {
      try {
        const parsed = JSON.parse(
          Buffer.from(pagination.cursor, 'base64').toString('utf-8'),
        );
        if (parsed.fc && !parsed.f) {
          isQueryNextFile = true;
        }
      } catch {
        // ignore
      }
    }

    // Fetch folders (skip only when we are exclusively paginating files)
    const folders = isQueryNextFile ? [] : await this.prisma.folder.findMany({
      where: parentWhere,
      orderBy: { id: 'desc' },
      select: {
        id: true,
        name: true,
        parentId: true,
        userId: true,
        visibility: true,
        shareToken: true,
        createdAt: true,
        updatedAt: true,
      },
      take: limit + 1,
    });

    const folderHasNext = folders.length > limit;
    const folderItems = folderHasNext ? folders.slice(0, -1) : folders;
    const nextFolderCursor = folderHasNext
      ? Buffer.from(
        JSON.stringify({ f: (folderItems[folderItems.length - 1] as { id: string }).id }),
      ).toString('base64')
      : null;

    // Fetch files:
    // - Always fetch when NOT paginating folders (initial load or file-only cursor)
    // - Also fetch when paginating folders but this is the LAST folder page (folderHasNext = false),
    //   so the frontend receives the first page of files and nextFileCursor if needed.
    const shouldFetchFiles = !isQueryNextFolder || !folderHasNext;
    const files = shouldFetchFiles ? await this.prisma.fileRecord.findMany({
      where: fileWhere,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: {
        id: true,
        filename: true,
        size: true,
        mimeType: true,
        status: true,
        totalChunks: true,
        folderId: true,
        userId: true,
        visibility: true,
        shareToken: true,
        createdAt: true,
        updatedAt: true,
      },
      take: limit + 1,
    }) : [];

    const fileHasNext = files.length > limit;
    const fileItems = fileHasNext ? files.slice(0, -1) : files;
    const nextFileCursor = fileHasNext
      ? Buffer.from(
        JSON.stringify({
          fc: `${(fileItems[fileItems.length - 1] as { createdAt: Date }).createdAt.toISOString()}_${(fileItems[fileItems.length - 1] as { id: string }).id}`,
        }),
      ).toString('base64')
      : null;

    // Count totals
    const [totalFolders, totalFiles] = await Promise.all([
      this.prisma.folder.count({ where: parentWhere }),
      this.prisma.fileRecord.count({ where: fileWhere }),
    ]);

    return {
      folders: folderItems,
      files: fileItems,
      nextFolderCursor,
      nextFileCursor,
      totalFolders,
      totalFiles,
    };
  }

  /**
   * Đổi tên folder
   */
  async rename(id: string, newName: string, userId: string) {
    const folder = await this.prisma.folder.findFirst({
      where: { id, userId, deletedAt: null },
      select: { id: true, name: true, parentId: true },
    });
    if (!folder) throw new NotFoundException('Folder not found');

    const conflict = await this.nameConflictService.checkFolderConflict(
      folder.parentId,
      newName,
      userId,
      id,
    );
    if (conflict) {
      throw new ConflictException({
        message:
          'A file or folder with this name already exists in the current folder',
        type: 'folder' as const,
      });
    }

    const updated = await this.prisma.folder.update({
      where: { id },
      data: { name: newName },
    });

    this.logger.log(
      `Folder renamed: "${folder.name}" to "${newName}" (id: ${id})`,
    );
    return updated;
  }

  /**
   * Di chuyển folder (chống circular reference)
   */
  async move(
    id: string,
    newParentId: string | null,
    userId: string,
    conflictAction?: ConflictAction,
  ) {
    const folder = await this.prisma.folder.findFirst({
      where: { id, userId, deletedAt: null },
      select: { id: true, name: true, parentId: true },
    });
    if (!folder) throw new NotFoundException('Folder not found');

    if (newParentId) {
      // 1. Không move vào chính mình
      if (id === newParentId) {
        throw new BadRequestException('Cannot move folder into itself');
      }

      // 2. Không move vào subfolder (circular reference check)
      let currentParentId: string | null = newParentId;
      while (currentParentId) {
        if (currentParentId === id) {
          throw new BadRequestException(
            'Cannot move folder into a subfolder of itself',
          );
        }
        const parentFolder: { parentId: string | null } | null =
          await this.prisma.folder.findUnique({
            where: { id: currentParentId },
            select: { parentId: true },
          });
        currentParentId = parentFolder?.parentId || null;
      }

      // 3. Dest folder phải tồn tại và thuộc về user
      const newParent = await this.prisma.folder.findFirst({
        where: { id: newParentId, userId, deletedAt: null },
        select: { id: true },
      });
      if (!newParent)
        throw new NotFoundException('Destination folder not found');
    }

    // Check conflict at destination
    const conflict = await this.nameConflictService.checkFolderConflict(
      newParentId,
      folder.name,
      userId,
      id,
    );

    if (conflict) {
      if (!conflictAction || conflictAction === 'skip') {
        throw new ConflictException({
          message:
            'A file or folder with this name already exists in the destination folder',
          type: 'folder' as const,
          id: conflict.id,
          name: conflict.name,
        });
      }

      if (conflictAction === 'merge') {
        // Merge nội dung source vào target, sau đó xoá source
        await this.nameConflictService.mergeFolderContents(
          id,
          conflict.id,
          userId,
        );
        // Xoá folder nguồn (sau khi đã merge hết nội dung)
        await this.prisma.folder.delete({ where: { id } });
        this.logger.log(
          `Folder merged during move: "${folder.name}" (id: ${id}) into "${conflict.name}" (id: ${conflict.id})`,
        );
        // Return target folder info
        const updated = await this.prisma.folder.findUnique({
          where: { id: conflict.id },
        });
        return updated;
      }
    }

    const updated = await this.prisma.folder.update({
      where: { id },
      data: { parentId: newParentId },
    });

    this.logger.log(
      `Folder moved: "${folder.name}" (id: ${id}) to parent: ${newParentId || 'root'}`,
    );
    return updated;
  }

  /**
   * Breadcrumbs — scope theo userId
   */
  async getBreadcrumbs(folderId: string, userId: string) {
    const breadcrumbs: Array<{ id: string; name: string }> = [];
    let currentId: string | null = folderId;

    while (currentId) {
      const folderData: {
        id: string;
        name: string;
        parentId: string | null;
      } | null = await this.prisma.folder.findFirst({
        where: { id: currentId, userId, deletedAt: null },
        select: { id: true, name: true, parentId: true },
      });
      if (!folderData) break;
      breadcrumbs.unshift({ id: folderData.id, name: folderData.name });
      currentId = folderData.parentId;
    }

    return breadcrumbs;
  }

  /**
   * Chia sẻ folder (tạo shareLink)
   */
  async share(id: string, userId: string) {
    const folder = await this.prisma.folder.findFirst({
      where: { id, userId, deletedAt: null },
    });
    if (!folder) throw new NotFoundException('Folder not found');

    const shareToken =
      folder.shareToken || crypto.randomBytes(16).toString('hex');

    const updated = await this.prisma.folder.update({
      where: { id },
      data: {
        visibility: 'PUBLIC_LINK',
        shareToken,
      },
    });

    this.logger.log(
      `Folder shared: "${folder.name}" (folderId: ${id}, token: ${shareToken})`,
    );
    return updated;
  }

  /**
   * Huỷ chia sẻ folder
   */
  async unshare(id: string, userId: string) {
    const folder = await this.prisma.folder.findFirst({
      where: { id, userId, deletedAt: null },
    });
    if (!folder) throw new NotFoundException('Folder not found');

    const updated = await this.prisma.folder.update({
      where: { id },
      data: {
        visibility: 'PRIVATE',
        shareToken: null,
      },
    });

    this.logger.log(`Folder unshared: "${folder.name}" (folderId: ${id})`);
    return updated;
  }

  /**
   * Lấy nội dung folder được chia sẻ (public)
   * Xác minh targetFolderId có nằm trong nhánh của root shared folder không.
   */
  async getSharedContent(
    token: string,
    targetFolderId?: string,
    pagination?: PaginationQueryDto,
  ) {
    const rootSharedFolder = await this.prisma.folder.findUnique({
      where: { shareToken: token },
      include: { user: { select: { username: true } } },
    });
    if (!rootSharedFolder || rootSharedFolder.deletedAt)
      throw new NotFoundException('Shared folder not found');

    const currentFolderId = targetFolderId || rootSharedFolder.id;

    // Verify currentFolderId is a descendant of rootSharedFolder
    const isChild = await this.isDescendantOf(
      currentFolderId,
      rootSharedFolder.id,
    );

    if (!isChild)
      throw new BadRequestException('Folder is not part of this shared link');

    if (pagination) {
      const limit = pagination.limit ?? 50;
      const folderWhere: Record<string, unknown> = {
        parentId: currentFolderId,
        deletedAt: null,
      };
      const filesWhere: Record<string, unknown> = {
        folderId: currentFolderId,
        status: 'complete',
        deletedAt: null,
      };

      if (pagination.search) {
        folderWhere['name'] = {
          contains: pagination.search,
          mode: 'insensitive' as const,
        };
        filesWhere['filename'] = {
          contains: pagination.search,
          mode: 'insensitive' as const,
        };
      }

      // Parse cursor for combined pagination
      if (pagination.cursor) {
        try {
          const parsed = JSON.parse(
            Buffer.from(pagination.cursor, 'base64').toString('utf-8'),
          );
          if (parsed.f) {
            folderWhere['id'] = { lt: parsed.f };
          }
          const fileWhere: Record<string, unknown> = { ...filesWhere };
          if (parsed.fc) {
            const [timestamp, id] = parsed.fc.split('_');
            fileWhere.OR = [
              { createdAt: { lt: new Date(timestamp) } },
              { createdAt: new Date(timestamp), id: { lt: id } },
            ];
          }

          const folders = await this.prisma.folder.findMany({
            where: folderWhere,
            orderBy: { id: 'desc' },
            take: limit + 1,
          });
          const foldersHasNext = folders.length > limit;
          const folderItems = foldersHasNext ? folders.slice(0, -1) : folders;
          const nextFolderCursor = foldersHasNext
            ? Buffer.from(
              JSON.stringify({
                f: (folderItems[folderItems.length - 1] as { id: string }).id,
              }),
            ).toString('base64')
            : null;

          const files = await this.prisma.fileRecord.findMany({
            where: fileWhere,
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            take: limit + 1,
          });
          const filesHasNext = files.length > limit;
          const fileItems = filesHasNext ? files.slice(0, -1) : files;
          const nextFileCursor = filesHasNext
            ? Buffer.from(
              JSON.stringify({
                fc: `${(fileItems[fileItems.length - 1] as { createdAt: Date }).createdAt.toISOString()}_${(fileItems[fileItems.length - 1] as { id: string }).id}`,
              }),
            ).toString('base64')
            : null;

          const breadcrumbs = await this.buildSharedBreadcrumbs(
            currentFolderId,
            rootSharedFolder,
          );

          return {
            rootFolder: rootSharedFolder,
            currentFolderId,
            folders: folderItems,
            files: fileItems,
            nextFolderCursor,
            nextFileCursor,
            breadcrumbs,
          };
        } catch {
          // Invalid cursor format, fall through to default fetch
        }
      }

      // Default fetch without cursor
      const folders = await this.prisma.folder.findMany({
        where: folderWhere,
        orderBy: { id: 'desc' },
        take: limit + 1,
      });
      const foldersHasNext = folders.length > limit;
      const folderItems = foldersHasNext ? folders.slice(0, -1) : folders;
      const nextFolderCursor = foldersHasNext
        ? Buffer.from(
          JSON.stringify({
            f: (folderItems[folderItems.length - 1] as { id: string }).id,
          }),
        ).toString('base64')
        : null;

      const fileWhere: Record<string, unknown> = { ...filesWhere };
      const files = await this.prisma.fileRecord.findMany({
        where: fileWhere,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: limit + 1,
      });
      const filesHasNext = files.length > limit;
      const fileItems = filesHasNext ? files.slice(0, -1) : files;
      const nextFileCursor = filesHasNext
        ? Buffer.from(
          JSON.stringify({
            fc: `${(fileItems[fileItems.length - 1] as { createdAt: Date }).createdAt.toISOString()}_${(fileItems[fileItems.length - 1] as { id: string }).id}`,
          }),
        ).toString('base64')
        : null;

      const breadcrumbs = await this.buildSharedBreadcrumbs(
        currentFolderId,
        rootSharedFolder,
      );

      return {
        rootFolder: rootSharedFolder,
        currentFolderId,
        folders: folderItems,
        files: fileItems,
        nextFolderCursor,
        nextFileCursor,
        breadcrumbs,
      };
    }

    // No pagination — fallback to old behavior
    const folders = await this.prisma.folder.findMany({
      where: { parentId: currentFolderId, deletedAt: null },
      orderBy: { createdAt: 'desc' },
    });
    const files = await this.prisma.fileRecord.findMany({
      where: { folderId: currentFolderId, status: 'complete', deletedAt: null },
      orderBy: { createdAt: 'desc' },
    });

    const breadcrumbs = await this.buildSharedBreadcrumbs(
      currentFolderId,
      rootSharedFolder,
    );

    return {
      rootFolder: rootSharedFolder,
      currentFolderId,
      folders,
      files,
      breadcrumbs,
    };
  }

  private async buildSharedBreadcrumbs(
    currentFolderId: string,
    rootSharedFolder: { id: string; name: string },
  ): Promise<{ id: string; name: string }[]> {
    const breadcrumbs = [];
    let bcId: string | null = currentFolderId;
    while (bcId && bcId !== rootSharedFolder.id) {
      const f: { id: string; name: string; parentId: string | null } | null =
        await this.prisma.folder.findUnique({
          where: { id: bcId },
          select: { id: true, name: true, parentId: true },
        });
      if (!f) break;
      breadcrumbs.unshift({ id: f.id, name: f.name });
      bcId = f.parentId;
    }
    breadcrumbs.unshift({
      id: rootSharedFolder.id,
      name: rootSharedFolder.name,
    });
    return breadcrumbs;
  }

  /**
   * Tải file public thuộc 1 thư mục được chia sẻ
   */
  async getSharedFileDownloadInfo(token: string, fileId: string) {
    const rootSharedFolder = await this.prisma.folder.findUnique({
      where: { shareToken: token },
    });
    if (!rootSharedFolder || rootSharedFolder.deletedAt)
      throw new NotFoundException('Shared folder not found');

    const fileRecord = await this.prisma.fileRecord.findFirst({
      where: { id: fileId, deletedAt: null },
      include: { chunks: { orderBy: { chunkIndex: 'asc' } } },
    });
    if (!fileRecord) throw new NotFoundException('File not found');
    if (fileRecord.status !== 'complete')
      throw new BadRequestException('File upload not completed yet');

    // Verify file is a descendant of rootSharedFolder
    if (!fileRecord.folderId)
      throw new BadRequestException('File is not part of this shared link');
    const isChild = await this.isDescendantOf(
      fileRecord.folderId,
      rootSharedFolder.id,
    );

    if (!isChild)
      throw new BadRequestException('File is not part of this shared link');

    return this.fileService.getDownloadMetadata(fileRecord);
  }

  /**
   * Xoá thư mục — đệ quy xoá tất cả nội dung bên trong.
   */
  async delete(id: string, userId: string) {
    return this.hardDeleteFolder(
      id,
      userId,
      { deletedAt: null },
      'Thư mục không tồn tại',
      'Folder deleted',
    );
  }

  /**
   * Xoá vĩnh viễn folder từ thùng rác — đệ quy xoá tất cả nội dung bên trong.
   */
  async permanentDelete(id: string, userId: string) {
    return this.hardDeleteFolder(
      id,
      userId,
      { deletedAt: { not: null } },
      'Thư mục không tồn tại trong thùng rác',
      'Folder permanently deleted from trash',
    );
  }

  /**
   * Shared logic for delete + permanentDelete:
   * collect files → delete from Telegram → cascade delete from DB.
   */
  private async hardDeleteFolder(
    id: string,
    userId: string,
    whereExtra: { deletedAt: null } | { deletedAt: { not: null } },
    notFoundMsg: string,
    logPrefix: string,
  ) {
    const folder = await this.prisma.folder.findFirst({
      where: { id, userId, ...whereExtra },
    });
    if (!folder) throw new NotFoundException(notFoundMsg);

    const allFileIds = await this.collectAllFileIds(id);

    // Atomically delete all files inside the folder tree before deleting the folder
    await this.fileService.bulkPermanentDeleteFiles(allFileIds, userId);

    await this.prisma.folder.delete({ where: { id } });

    this.logger.log(
      `${logPrefix}: "${folder.name}" (id: ${id}, files cleaned: ${allFileIds.length})`,
    );
    return folder;
  }

  /**
   * Soft delete thư mục — đệ quy soft-delete tất cả file/subfolder bên trong.
   * Giữ nguyên usedSpace.
   */
  async softDelete(id: string, userId: string) {
    const folder = await this.prisma.folder.findFirst({
      where: { id, userId, deletedAt: null },
    });
    if (!folder) throw new NotFoundException('Thư mục không tồn tại');

    const now = new Date();
    await this.softDeleteRecursive(id, now);

    this.logger.log(
      `Folder soft-deleted: "${folder.name}" (id: ${id}, userId: ${userId})`,
    );
    return folder;
  }

  /**
   * Đệ quy soft-delete folder và tất cả nội dung bên trong.
   */
  private async softDeleteRecursive(
    folderId: string,
    deletedAt: Date,
  ): Promise<void> {
    // Soft-delete tất cả files trong folder
    await this.prisma.fileRecord.updateMany({
      where: { folderId, deletedAt: null },
      data: { deletedAt },
    });

    // Tìm tất cả subfolder chưa bị xoá
    const children = await this.prisma.folder.findMany({
      where: { parentId: folderId, deletedAt: null },
      select: { id: true },
    });

    // Đệ quy soft-delete từng subfolder
    for (const child of children) {
      await this.softDeleteRecursive(child.id, deletedAt);
    }

    // Soft-delete folder hiện tại
    await this.prisma.folder.update({
      where: { id: folderId },
      data: { deletedAt },
    });
  }

  /**
   * Khôi phục folder từ thùng rác — đệ quy khôi phục nội dung.
   * Nếu tên bị chiếm tại vị trí cũ → auto-rename + trả về suggested name.
   */
  async restore(
    id: string,
    userId: string,
  ): Promise<{ folder: { id: string; name: string }; autoRenamed: boolean }> {
    const folder = await this.prisma.folder.findFirst({
      where: { id, userId, deletedAt: { not: null } },
    });
    if (!folder) throw new NotFoundException('Folder not found in trash');

    // Check nếu tên folder bị chiếm tại vị trí cũ (parentId)
    const conflict = await this.nameConflictService.checkFolderConflict(
      folder.parentId,
      folder.name,
      userId,
      id,
    );

    let autoRenamed = false;
    let finalName = folder.name;

    if (conflict) {
      const existingNames = await this.nameConflictService.getExistingNames(
        folder.parentId,
        userId,
      );
      finalName = this.nameConflictService.generateUniqueName(
        folder.name,
        existingNames,
      );
      autoRenamed = true;
      this.logger.log(
        `Folder restore auto-renamed: "${folder.name}" to "${finalName}" (id: ${id})`,
      );
    }

    await this.restoreRecursive(id, folder.deletedAt!);

    // Update tên folder nếu có auto-rename
    if (autoRenamed) {
      await this.prisma.folder.update({
        where: { id },
        data: { name: finalName },
      });
    }

    this.logger.log(
      `Folder restored: "${finalName}" (id: ${id}, userId: ${userId})`,
    );
    return {
      folder: { id, name: finalName },
      autoRenamed,
    };
  }

  /**
   * Đệ quy khôi phục folder và nội dung bên trong.
   * Chỉ khôi phục items có cùng deletedAt timestamp (items bị xoá trước khi folder bị xoá sẽ không khôi phục).
   */
  private async restoreRecursive(
    folderId: string,
    deletedAt: Date,
  ): Promise<void> {
    // Khôi phục files có cùng deletedAt
    await this.prisma.fileRecord.updateMany({
      where: { folderId, deletedAt },
      data: { deletedAt: null },
    });

    // Tìm subfolders có cùng deletedAt
    const children = await this.prisma.folder.findMany({
      where: { parentId: folderId, deletedAt },
      select: { id: true },
    });

    for (const child of children) {
      await this.restoreRecursive(child.id, deletedAt);
    }

    // Khôi phục folder hiện tại
    await this.prisma.folder.update({
      where: { id: folderId },
      data: { deletedAt: null },
    });
  }

  /**
   * Danh sách folders trong thùng rác — chỉ hiện top-level (folders bị xoá trực tiếp,
   * không hiện subfolders đã bị xoá theo cascade).
   */
  async listTrash(
    userId: string,
    pagination: PaginationQueryDto,
  ): Promise<PaginatedResponse<unknown>> {
    const limit = pagination.limit ?? 20;
    const where: Record<string, unknown> = {
      userId,
      deletedAt: { not: null },
      OR: [{ parentId: null }, { parent: { deletedAt: null } }],
    };

    if (pagination.search) {
      where.name = { contains: pagination.search, mode: 'insensitive' };
    }

    if (pagination.cursor) {
      try {
        const decoded = Buffer.from(pagination.cursor, 'base64').toString(
          'utf-8',
        );
        const [timestamp, id] = decoded.split('_');
        where.deletedAt = {
          lt: new Date(timestamp),
        };
        // Secondary sort by id for same timestamp
        where.OR = [
          { deletedAt: { lt: new Date(timestamp) } },
          { deletedAt: new Date(timestamp), id: { lt: id } },
        ];
      } catch {
        // Invalid cursor, ignore
      }
    }

    const data = await this.prisma.folder.findMany({
      where,
      orderBy: [{ deletedAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });

    const hasNext = data.length > limit;
    const items = hasNext ? data.slice(0, -1) : data;
    const nextCursor = hasNext
      ? Buffer.from(
        `${(items[items.length - 1] as { deletedAt: Date }).deletedAt.toISOString()}_${(items[items.length - 1] as { id: string }).id}`,
      ).toString('base64')
      : null;

    const total = await this.prisma.folder.count({ where });

    return { data: items, nextCursor, total };
  }

  /**
   * Đệ quy thu thập tất cả file IDs trong thư mục và các thư mục con
   */
  private async collectAllFileIds(folderId: string): Promise<string[]> {
    const fileIds: string[] = [];

    const files = await this.prisma.fileRecord.findMany({
      where: { folderId },
      select: { id: true },
    });
    fileIds.push(...files.map((f) => f.id));

    const children = await this.prisma.folder.findMany({
      where: { parentId: folderId },
      select: { id: true },
    });
    for (const child of children) {
      const childFileIds = await this.collectAllFileIds(child.id);
      fileIds.push(...childFileIds);
    }

    return fileIds;
  }

  /**
   * Kiểm tra folderId có phải descendant (hoặc chính nó) của ancestorId.
   * Đi ngược parent chain, bỏ qua folder đã soft-delete.
   */
  /**
   * Tạo signed download URL cho file trong shared folder
   */
  async generateShareFolderDownloadToken(
    shareToken: string,
    fileId: string,
  ): Promise<{ url: string; expiresAt: string }> {
    const rootSharedFolder = await this.prisma.folder.findUnique({
      where: { shareToken },
    });
    if (!rootSharedFolder || rootSharedFolder.deletedAt)
      throw new NotFoundException('Shared folder not found');

    const fileRecord = await this.prisma.fileRecord.findFirst({
      where: { id: fileId, deletedAt: null },
      select: { id: true, folderId: true, status: true },
    });
    if (!fileRecord) throw new NotFoundException('File not found');
    if (fileRecord.status !== 'complete')
      throw new BadRequestException('File upload not completed yet');
    if (!fileRecord.folderId)
      throw new BadRequestException('File is not part of this shared link');

    const isChild = await this.isDescendantOf(
      fileRecord.folderId,
      rootSharedFolder.id,
    );
    if (!isChild)
      throw new BadRequestException('File is not part of this shared link');

    const ttl = await this.fileService.getDownloadTtl();
    const token = this.cryptoService.createSignedToken(fileId, 'sf', ttl);
    const expiresAt = new Date(Date.now() + ttl * 1000).toISOString();

    this.logger.debug(
      `Share folder download token generated: shareToken=${shareToken}, fileId=${fileId}, ttl=${ttl}s`,
    );
    return { url: `/files/d/${token}`, expiresAt };
  }

  private async isDescendantOf(
    folderId: string,
    ancestorId: string,
  ): Promise<boolean> {
    let currentId: string | null = folderId;
    while (currentId) {
      if (currentId === ancestorId) return true;
      const folder: { parentId: string | null; deletedAt: Date | null } | null =
        await this.prisma.folder.findUnique({
          where: { id: currentId },
          select: { parentId: true, deletedAt: true },
        });
      if (!folder || folder.deletedAt) return false;
      currentId = folder.parentId;
    }
    return false;
  }
}
