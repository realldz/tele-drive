import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { S3AuthService } from './s3-auth.service';

/**
 * S3AuthGuard — NestJS Guard kiểm tra AWS Signature V4 trên mọi route /s3/**
 *
 * Gắn userId vào req.s3UserId nếu xác thực thành công.
 */
@Injectable()
export class S3AuthGuard implements CanActivate {
  private readonly logger = new Logger(S3AuthGuard.name);

  constructor(private readonly s3AuthService: S3AuthService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();

    const userId = await this.s3AuthService.verifySignature(req);

    if (!userId) {
      this.logger.warn(
        `S3 auth denied: ${req.method} ${req.url} from ${req.ip}`,
      );
      throw new UnauthorizedException({
        code: 'InvalidSignature',
        message:
          'The request signature we calculated does not match the signature you provided.',
      });
    }

    // Attach userId to request for downstream use
    req.s3UserId = userId;
    return true;
  }
}
