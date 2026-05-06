import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class AdminDashboardService {
  constructor(private readonly prisma: PrismaService) {}

  async getSummary() {
    const [
      totalUsers,
      totalAdmins,
      totalFiles,
      totalFolders,
      totalTrashFiles,
      totalTrashFolders,
      totalUploadsInProgress,
      totalS3Credentials,
      users,
      topUsersByUsage,
    ] = await Promise.all([
      this.prisma.user.count(),
      this.prisma.user.count({ where: { role: 'ADMIN' } }),
      this.prisma.fileRecord.count({ where: { deletedAt: null } }),
      this.prisma.folder.count({ where: { deletedAt: null } }),
      this.prisma.fileRecord.count({ where: { deletedAt: { not: null } } }),
      this.prisma.folder.count({ where: { deletedAt: { not: null } } }),
      this.prisma.fileRecord.count({ where: { status: 'uploading' } }),
      this.prisma.s3Credential.count({ where: { isActive: true } }),
      this.prisma.user.findMany({
        select: {
          usedSpace: true,
          quota: true,
        },
      }),
      this.prisma.user.findMany({
        orderBy: [{ usedSpace: 'desc' }, { username: 'asc' }],
        take: 5,
        select: {
          id: true,
          username: true,
          usedSpace: true,
          quota: true,
          role: true,
        },
      }),
    ]);

    const totalUsedSpace = users.reduce(
      (sum, user) => sum + user.usedSpace,
      0n,
    );
    const totalQuota = users.reduce((sum, user) => sum + user.quota, 0n);

    return {
      totalUsers,
      totalAdmins,
      totalFiles,
      totalFolders,
      totalTrashFiles,
      totalTrashFolders,
      totalUploadsInProgress,
      totalS3Credentials,
      totalUsedSpace,
      totalQuota,
      topUsersByUsage,
    };
  }
}
