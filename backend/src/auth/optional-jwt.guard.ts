import {
  Injectable,
  CanActivate,
  ExecutionContext,
  Logger,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';

/**
 * OptionalJwtGuard — cố gắng xác thực JWT nhưng KHÔNG reject nếu thiếu hoặc invalid.
 *
 * Dùng trên @Public() routes (share pages) để nhận diện người dùng đã đăng nhập
 * và áp dụng đúng user quota (thay vì guest quota) trong BandwidthInterceptor.
 *
 * Nếu có JWT hợp lệ → req.user được set.
 * Nếu không có JWT hoặc JWT expired → req.user = undefined (fallback guest).
 * Luôn return true — KHÔNG bao giờ chặn request.
 */
@Injectable()
export class OptionalJwtGuard implements CanActivate {
  private readonly logger = new Logger(OptionalJwtGuard.name);

  constructor(private readonly jwtService: JwtService) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest();
    const authHeader = req.headers.authorization;

    if (!authHeader?.startsWith('Bearer ')) {
      return true;
    }

    try {
      const token = authHeader.slice(7);
      const payload = this.jwtService.verify(token);
      req.user = {
        userId: payload.sub,
        username: payload.username,
        role: payload.role,
      };
    } catch {
      // Token invalid, expired, hoặc sai định dạng → bỏ qua, cho khách
    }

    return true;
  }
}
