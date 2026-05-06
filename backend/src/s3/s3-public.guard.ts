import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  ForbiddenException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { SettingsService } from '../settings/settings.service';

/**
 * S3PublicGuard — kiểm tra quyền truy cập public cho bucket S3.
 *
 * Flow:
 *  1. Lấy userId từ req.params.userId (URL path)
 *  2. Lấy bucket từ req.params.bucket
 *  3. Kiểm tra SystemSetting "S3_PUBLIC_ACCESS_ENABLED" (admin master switch)
 *  4. Kiểm tra Folder: đúng userId, name=bucket, parentId=null,
 *     s3PublicAccess=true, deletedAt=null
 *  5. Nếu hợp lệ → gán req.s3UserId = userId, return true
 *  6. Nếu không → 403 AccessDenied
 */
@Injectable()
export class S3PublicGuard implements CanActivate {
  private readonly logger = new Logger(S3PublicGuard.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly settingsService: SettingsService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();

    const userId = req.params?.userId as string | undefined;
    const bucket = req.params?.bucket as string | undefined;

    if (!userId || !bucket) {
      throw new ForbiddenException('AccessDenied');
    }

    const enabled = await this.settingsService.getCachedSetting(
      'S3_PUBLIC_ACCESS_ENABLED',
      true,
      (v) => v !== 'false',
    );

    if (!enabled) {
      this.logger.warn(
        `S3 public access disabled by admin: ${req.method} ${req.url}`,
      );
      throw new ForbiddenException('AccessDenied');
    }

    const folder = await this.prisma.folder.findFirst({
      where: {
        userId,
        name: bucket,
        parentId: null,
        s3PublicAccess: true,
        deletedAt: null,
      },
      select: { id: true },
    });

    if (!folder) {
      this.logger.warn(
        `S3 public access denied: bucket "${bucket}" not public for user ${userId}`,
      );
      throw new ForbiddenException('AccessDenied');
    }

    req.s3UserId = userId;
    req.s3PublicAccess = true;
    return true;
  }
}
