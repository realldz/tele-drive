import { Injectable, CanActivate, ExecutionContext, ForbiddenException, Logger } from '@nestjs/common';

/**
 * Admin Guard — kiểm tra req.user.role === 'ADMIN'.
 * Dùng cho các route quản trị (user management, system settings).
 * Phải đặt SAU JwtAuthGuard (req.user đã được inject).
 */
@Injectable()
export class AdminGuard implements CanActivate {
  private readonly logger = new Logger(AdminGuard.name);

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    const user = request.user;

    if (!user || user.role !== 'ADMIN') {
      const route = `${request.method} ${request.url}`;
      this.logger.warn(`Admin access denied: user ${user?.userId || 'unknown'} (role: ${user?.role || 'none'}) attempted ${route}`);
      throw new ForbiddenException('Admin access required');
    }

    return true;
  }
}
