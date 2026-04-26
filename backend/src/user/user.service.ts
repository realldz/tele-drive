import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  UnauthorizedException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { FileService } from '../file/file.service';
import { PaginationQueryDto } from '../common/dto/pagination-query.dto';
import { PaginatedResponse } from '../common/types/paginated-response.type';
import * as bcrypt from 'bcrypt';

@Injectable()
export class UserService {
  private readonly logger = new Logger(UserService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly fileService: FileService,
  ) {}

  /**
   * GET /users/me — Profile user hiện tại
   */
  async getMe(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        username: true,
        role: true,
        quota: true,
        usedSpace: true,
        dailyBandwidthLimit: true,
        dailyBandwidthUsed: true,
        lastBandwidthReset: true,
        createdAt: true,
      },
    });
    if (!user) throw new NotFoundException('User not found');
    return user;
  }

  /**
   * GET /users — Danh sách tất cả user (Admin only), hỗ trợ pagination + search
   */
  async findAll(
    pagination: PaginationQueryDto,
  ): Promise<PaginatedResponse<unknown>> {
    const limit = pagination.limit ?? 20;
    const where: Record<string, unknown> = {};

    if (pagination.search) {
      where.username = { contains: pagination.search, mode: 'insensitive' };
    }

    if (pagination.cursor) {
      where.id = { gt: pagination.cursor };
    }

    const data = await this.prisma.user.findMany({
      where,
      select: {
        id: true,
        username: true,
        role: true,
        quota: true,
        usedSpace: true,
        dailyBandwidthLimit: true,
        dailyBandwidthUsed: true,
        lastBandwidthReset: true,
        createdAt: true,
        updatedAt: true,
      },
      orderBy: { id: 'asc' },
      take: limit + 1,
    });

    const hasNext = data.length > limit;
    const items = hasNext ? data.slice(0, -1) : data;
    const nextCursor = hasNext
      ? (items[items.length - 1] as { id: string }).id
      : null;

    const total = await this.prisma.user.count({ where });

    return { data: items, nextCursor, total };
  }

  /**
   * PATCH /users/:id/quota — Cập nhật quota cho user (Admin only)
   */
  async updateQuota(targetUserId: string, quota: bigint) {
    const user = await this.prisma.user.findUnique({
      where: { id: targetUserId },
    });
    if (!user) throw new NotFoundException('User not found');

    if (quota < 0) {
      throw new BadRequestException('Quota must be a non-negative value');
    }

    const updated = await this.prisma.user.update({
      where: { id: targetUserId },
      data: { quota },
      select: { id: true, username: true, quota: true, usedSpace: true },
    });

    this.logger.log(
      `Quota updated: user "${user.username}" (id: ${targetUserId}) → ${quota} bytes`,
    );
    return updated;
  }

  /**
   * PATCH /users/:id/bandwidth-limit — Cập nhật bandwidth limit (Admin only)
   */
  async updateBandwidthLimit(
    targetUserId: string,
    dailyBandwidthLimit: bigint | null,
  ) {
    const user = await this.prisma.user.findUnique({
      where: { id: targetUserId },
    });
    if (!user) throw new NotFoundException('User not found');

    if (dailyBandwidthLimit !== null && dailyBandwidthLimit < 0) {
      throw new BadRequestException(
        'Bandwidth limit must be a non-negative value or null',
      );
    }

    const updated = await this.prisma.user.update({
      where: { id: targetUserId },
      data: { dailyBandwidthLimit },
      select: { id: true, username: true, dailyBandwidthLimit: true },
    });

    this.logger.log(
      `Bandwidth limit updated: user "${user.username}" (id: ${targetUserId}) → ${dailyBandwidthLimit === null ? 'system default' : `${dailyBandwidthLimit} bytes/day`}`,
    );
    return updated;
  }

  /**
   * DELETE /users/:id — Xoá user và tất cả data (Admin only)
   * Permanent delete: xoá file trên Telegram, xoá folders, xoá user
   */
  async deleteUser(targetUserId: string, requestingUserId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: targetUserId },
    });
    if (!user) throw new NotFoundException('User not found');

    // Không cho phép admin tự xoá chính mình
    if (targetUserId === requestingUserId) {
      throw new BadRequestException('Cannot delete your own account');
    }

    // Xoá tất cả file trên Telegram
    const files = await this.prisma.fileRecord.findMany({
      where: { userId: targetUserId },
      select: { id: true },
    });

    for (const file of files) {
      await this.fileService
        .delete(file.id)
        .catch((err) =>
          this.logger.warn(
            `Failed to delete file ${file.id} from Telegram during user deletion: ${err}`,
          ),
        );
    }

    // Xoá tất cả folders (cascade sẽ xoá file records còn sót)
    await this.prisma.folder.deleteMany({ where: { userId: targetUserId } });

    // Xoá file records không có folder (root-level files)
    await this.prisma.fileRecord.deleteMany({
      where: { userId: targetUserId },
    });

    // Xoá user
    await this.prisma.user.delete({ where: { id: targetUserId } });

    this.logger.log(
      `User deleted: "${user.username}" (id: ${targetUserId}, files cleaned: ${files.length})`,
    );
    return { success: true, deletedFiles: files.length };
  }

  /**
   * PATCH /users/:id/role — Cập nhật role (Admin only)
   */
  async updateRole(
    targetUserId: string,
    role: string,
    requestingUserId: string,
  ) {
    if (targetUserId === requestingUserId && role !== 'ADMIN') {
      throw new BadRequestException('Cannot remove your own admin role');
    }
    const user = await this.prisma.user.update({
      where: { id: targetUserId },
      data: { role },
      select: { id: true, username: true, role: true },
    });
    this.logger.log(
      `Role updated: user "${user.username}" (id: ${targetUserId}) → ${role}`,
    );
    return user;
  }

  /**
   * GET /users/:id/files — Lấy danh sách metadata các file của user (Admin only)
   * Hỗ trợ pagination + search
   */
  async getUserFiles(
    targetUserId: string,
    pagination: PaginationQueryDto,
  ): Promise<PaginatedResponse<unknown>> {
    const limit = pagination.limit ?? 20;
    const where: Record<string, unknown> = {
      userId: targetUserId,
      deletedAt: null,
    };

    if (pagination.search) {
      where.filename = {
        contains: pagination.search,
        mode: 'insensitive',
      };
    }

    // Parse cursor: format is "timestamp_id" base64 encoded
    if (pagination.cursor) {
      try {
        const decoded = Buffer.from(pagination.cursor, 'base64').toString(
          'utf-8',
        );
        const [timestamp, id] = decoded.split('_');
        where.OR = [
          { createdAt: { lt: new Date(timestamp) } },
          { createdAt: new Date(timestamp), id: { lt: id } },
        ];
      } catch {
        // Invalid cursor, ignore
      }
    }

    const data = await this.prisma.fileRecord.findMany({
      where,
      select: {
        id: true,
        filename: true,
        size: true,
        mimeType: true,
        createdAt: true,
        updatedAt: true,
        isEncrypted: true,
        downloads24h: true,
        downloadLimit24h: true,
        bandwidthUsed24h: true,
        bandwidthLimit24h: true,
        lastDownloadReset: true,
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });

    const hasNext = data.length > limit;
    const items = hasNext ? data.slice(0, -1) : data;
    const nextCursor = hasNext
      ? Buffer.from(
          `${(items[items.length - 1] as { createdAt: Date }).createdAt.toISOString()}_${(items[items.length - 1] as { id: string }).id}`,
        ).toString('base64')
      : null;

    const total = await this.prisma.fileRecord.count({ where });

    return { data: items, nextCursor, total };
  }

  async getUserBasic(targetUserId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: targetUserId },
      select: {
        id: true,
        username: true,
        role: true,
        usedSpace: true,
        quota: true,
      },
    });

    if (!user) throw new NotFoundException('User not found');
    return user;
  }

  async updateFileDownloadPolicy(
    targetUserId: string,
    fileId: string,
    data: {
      downloadLimit24h?: number | null;
      bandwidthLimit24h?: string | null;
    },
  ) {
    const file = await this.prisma.fileRecord.findFirst({
      where: { id: fileId, userId: targetUserId, deletedAt: null },
      select: { id: true, filename: true },
    });
    if (!file) throw new NotFoundException('File not found for this user');

    const updateData: {
      downloadLimit24h?: number | null;
      bandwidthLimit24h?: bigint | null;
    } = {};

    if (Object.prototype.hasOwnProperty.call(data, 'downloadLimit24h')) {
      updateData.downloadLimit24h = data.downloadLimit24h ?? null;
    }

    if (Object.prototype.hasOwnProperty.call(data, 'bandwidthLimit24h')) {
      updateData.bandwidthLimit24h =
        data.bandwidthLimit24h === null ||
        data.bandwidthLimit24h === undefined ||
        data.bandwidthLimit24h === ''
          ? null
          : BigInt(data.bandwidthLimit24h);
    }

    const updated = await this.prisma.fileRecord.update({
      where: { id: fileId },
      data: updateData,
      select: {
        id: true,
        filename: true,
        downloadLimit24h: true,
        downloads24h: true,
        bandwidthLimit24h: true,
        bandwidthUsed24h: true,
        lastDownloadReset: true,
      },
    });

    this.logger.log(
      `File download policy updated: file "${file.filename}" (id: ${fileId}) for user ${targetUserId}`,
    );

    return updated;
  }

  /**
   * DELETE /users/:id/files/:fileId — Xoá file của user (Admin only)
   */
  async deleteUserFile(targetUserId: string, fileId: string) {
    const file = await this.prisma.fileRecord.findFirst({
      where: { id: fileId, userId: targetUserId },
    });
    if (!file) throw new NotFoundException('File not found for this user');

    this.logger.warn(
      `Admin deleting file: "${file.filename}" (id: ${fileId}) of user ${targetUserId}`,
    );
    return this.fileService.delete(fileId);
  }

  /**
   * PATCH /users/me/password — User tự đổi mật khẩu
   */
  async changePassword(
    userId: string,
    currentPassword: string,
    newPassword: string,
  ) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found');

    const isMatch = await bcrypt.compare(currentPassword, user.password);
    if (!isMatch) {
      throw new UnauthorizedException('Current password is incorrect');
    }

    if (newPassword.length < 4) {
      throw new BadRequestException(
        'New password must be at least 4 characters',
      );
    }

    const hashedPassword = await bcrypt.hash(newPassword, 10);
    await this.prisma.user.update({
      where: { id: userId },
      data: { password: hashedPassword },
    });

    this.logger.log(
      `Password changed: user "${user.username}" (id: ${userId})`,
    );
    return { success: true };
  }

  /**
   * PATCH /users/:id/password — Admin ép buộc reset mật khẩu cho user
   */
  async adminResetPassword(targetUserId: string, newPassword: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: targetUserId },
    });
    if (!user) throw new NotFoundException('User not found');

    if (newPassword.length < 4) {
      throw new BadRequestException(
        'New password must be at least 4 characters',
      );
    }

    const hashedPassword = await bcrypt.hash(newPassword, 10);
    await this.prisma.user.update({
      where: { id: targetUserId },
      data: { password: hashedPassword },
    });

    this.logger.log(
      `Admin reset password for user "${user.username}" (id: ${targetUserId})`,
    );
    return { success: true };
  }
}
