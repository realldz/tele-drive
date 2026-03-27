import { Injectable, Logger, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { FileService } from '../file/file.service';
import * as crypto from 'crypto';

@Injectable()
export class FolderService {
  private readonly logger = new Logger(FolderService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly fileService: FileService,
  ) { }

  /**
   * Tạo folder mới — userId lấy từ JWT
   */
  async create(name: string, userId: string, parentId?: string) {
    // Nếu có parentId, kiểm tra folder cha thuộc về user
    if (parentId) {
      const parentFolder = await this.prisma.folder.findFirst({
        where: { id: parentId, userId, deletedAt: null },
      });
      if (!parentFolder) throw new NotFoundException('Parent folder not found');
    }

    const folder = await this.prisma.folder.create({
      data: {
        name,
        parentId,
        userId,
      },
    });

    this.logger.log(`Folder created: "${name}" (id: ${folder.id}, parentId: ${parentId || 'root'}, userId: ${userId})`);
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
   */
  async getContent(userId: string, folderId?: string) {
    const folders = await this.prisma.folder.findMany({
      where: { parentId: folderId || null, userId, deletedAt: null },
      orderBy: { createdAt: 'desc' },
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
    });
    const files = await this.prisma.fileRecord.findMany({
      where: {
        folderId: folderId || null,
        userId,
        status: { in: ['complete', 'uploading'] },
        deletedAt: null
      },
      orderBy: { createdAt: 'desc' },
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
    });
    return { folders, files };
  }

  /**
   * Đổi tên folder
   */
  async rename(id: string, newName: string, userId: string) {
    const folder = await this.prisma.folder.findFirst({
      where: { id, userId, deletedAt: null },
    });
    if (!folder) throw new NotFoundException('Folder not found');

    const updated = await this.prisma.folder.update({
      where: { id },
      data: { name: newName },
    });

    this.logger.log(`Folder renamed: "${folder.name}" to "${newName}" (id: ${id})`);
    return updated;
  }

  /**
   * Di chuyển folder (chống circular reference)
   */
  async move(id: string, newParentId: string | null, userId: string) {
    const folder = await this.prisma.folder.findFirst({
      where: { id, userId, deletedAt: null },
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
          throw new BadRequestException('Cannot move folder into a subfolder of itself');
        }
        const parentFolder: { parentId: string | null } | null = await this.prisma.folder.findUnique({
          where: { id: currentParentId as string },
          select: { parentId: true },
        });
        currentParentId = parentFolder?.parentId || null;
      }

      // 3. Dest folder phải tồn tại và thuộc về user
      const newParent = await this.prisma.folder.findFirst({
        where: { id: newParentId, userId, deletedAt: null },
      });
      if (!newParent) throw new NotFoundException('Destination folder not found');
    }

    const updated = await this.prisma.folder.update({
      where: { id },
      data: { parentId: newParentId },
    });

    this.logger.log(`Folder moved: "${folder.name}" (id: ${id}) to parent: ${newParentId || 'root'}`);
    return updated;
  }

  /**
   * Breadcrumbs — scope theo userId
   */
  async getBreadcrumbs(folderId: string, userId: string) {
    const breadcrumbs: Array<{ id: string; name: string }> = [];
    let currentId: string | null = folderId;

    while (currentId) {
      const folderData: { id: string; name: string; parentId: string | null } | null =
        await this.prisma.folder.findFirst({
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

    const shareToken = folder.shareToken || crypto.randomBytes(16).toString('hex');

    const updated = await this.prisma.folder.update({
      where: { id },
      data: {
        visibility: 'PUBLIC_LINK',
        shareToken,
      },
    });

    this.logger.log(`Folder shared: "${folder.name}" (folderId: ${id}, token: ${shareToken})`);
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
  async getSharedContent(token: string, targetFolderId?: string) {
    const rootSharedFolder = await this.prisma.folder.findUnique({
      where: { shareToken: token },
      include: { user: { select: { username: true } } },
    });
    if (!rootSharedFolder || rootSharedFolder.deletedAt) throw new NotFoundException('Shared folder not found');

    let currentFolderId = targetFolderId || rootSharedFolder.id;

    // Verify currentFolderId is a descendant of rootSharedFolder
    const isChild = await this.isDescendantOf(currentFolderId, rootSharedFolder.id);

    if (!isChild) throw new BadRequestException('Folder is not part of this shared link');

    // Fetch content of currentFolderId
    const folders = await this.prisma.folder.findMany({
      where: { parentId: currentFolderId, deletedAt: null },
      orderBy: { createdAt: 'desc' },
    });
    const files = await this.prisma.fileRecord.findMany({
      where: { folderId: currentFolderId, status: 'complete', deletedAt: null },
      orderBy: { createdAt: 'desc' },
    });

    // Build breadcrumbs relative to the shared root
    const breadcrumbs = [];
    let bcId: string | null = currentFolderId;
    while (bcId && bcId !== rootSharedFolder.id) {
       const f: { id: string; name: string; parentId: string | null } | null = await this.prisma.folder.findUnique({
         where: { id: bcId },
         select: { id: true, name: true, parentId: true },
       });
       if (!f) break;
       breadcrumbs.unshift({ id: f.id, name: f.name });
       bcId = f.parentId;
    }
    // Always add the root folder as the first breadcrumb
    breadcrumbs.unshift({ id: rootSharedFolder.id, name: rootSharedFolder.name });

    return { rootFolder: rootSharedFolder, currentFolderId, folders, files, breadcrumbs };
  }

  /**
   * Tải file public thuộc 1 thư mục được chia sẻ
   */
  async getSharedFileDownloadInfo(token: string, fileId: string) {
    const rootSharedFolder = await this.prisma.folder.findUnique({
      where: { shareToken: token },
    });
    if (!rootSharedFolder || rootSharedFolder.deletedAt) throw new NotFoundException('Shared folder not found');

    const fileRecord = await this.prisma.fileRecord.findFirst({
      where: { id: fileId, deletedAt: null },
      include: { chunks: { orderBy: { chunkIndex: 'asc' } } },
    });
    if (!fileRecord) throw new NotFoundException('File not found');
    if (fileRecord.status !== 'complete') throw new BadRequestException('File upload not completed yet');

    // Verify file is a descendant of rootSharedFolder
    if (!fileRecord.folderId) throw new BadRequestException('File is not part of this shared link');
    const isChild = await this.isDescendantOf(fileRecord.folderId, rootSharedFolder.id);

    if (!isChild) throw new BadRequestException('File is not part of this shared link');

    return this.fileService.getDownloadMetadata(fileRecord);
  }

  /**
   * Xoá thư mục — đệ quy xoá tất cả nội dung bên trong.
   */
  async delete(id: string, userId: string) {
    return this.hardDeleteFolder(id, userId, { deletedAt: null }, 'Thư mục không tồn tại', 'Folder deleted');
  }

  /**
   * Xoá vĩnh viễn folder từ thùng rác — đệ quy xoá tất cả nội dung bên trong.
   */
  async permanentDelete(id: string, userId: string) {
    return this.hardDeleteFolder(id, userId, { deletedAt: { not: null } }, 'Thư mục không tồn tại trong thùng rác', 'Folder permanently deleted from trash');
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

    const deletePromises = allFileIds.map(fileId =>
      this.fileService.delete(fileId).catch(err =>
        this.logger.warn(`Failed to delete file ${fileId} from Telegram during folder cleanup: ${err}`)
      )
    );
    await Promise.allSettled(deletePromises);

    await this.prisma.folder.delete({ where: { id } });

    this.logger.log(`${logPrefix}: "${folder.name}" (id: ${id}, files cleaned: ${allFileIds.length})`);
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

    this.logger.log(`Folder soft-deleted: "${folder.name}" (id: ${id}, userId: ${userId})`);
    return folder;
  }

  /**
   * Đệ quy soft-delete folder và tất cả nội dung bên trong.
   */
  private async softDeleteRecursive(folderId: string, deletedAt: Date): Promise<void> {
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
   */
  async restore(id: string, userId: string) {
    const folder = await this.prisma.folder.findFirst({
      where: { id, userId, deletedAt: { not: null } },
    });
    if (!folder) throw new NotFoundException('Folder not found in trash');

    await this.restoreRecursive(id, folder.deletedAt!);

    this.logger.log(`Folder restored: "${folder.name}" (id: ${id}, userId: ${userId})`);
    return folder;
  }

  /**
   * Đệ quy khôi phục folder và nội dung bên trong.
   * Chỉ khôi phục items có cùng deletedAt timestamp (items bị xoá trước khi folder bị xoá sẽ không khôi phục).
   */
  private async restoreRecursive(folderId: string, deletedAt: Date): Promise<void> {
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
  async listTrash(userId: string) {
    return this.prisma.folder.findMany({
      where: {
        userId,
        deletedAt: { not: null },
        // Chỉ hiện folder "gốc" trong trash: folder cha phải đang active hoặc là root
        OR: [
          { parentId: null },
          { parent: { deletedAt: null } },
        ],
      },
      orderBy: { deletedAt: 'desc' },
    });
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
    fileIds.push(...files.map(f => f.id));

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
  private async isDescendantOf(folderId: string, ancestorId: string): Promise<boolean> {
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
