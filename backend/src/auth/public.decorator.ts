import { SetMetadata } from '@nestjs/common';

/**
 * Decorator đánh dấu route là public — không cần JWT authentication.
 * Dùng cho: login, register, share link, health check...
 */
export const IS_PUBLIC_KEY = 'isPublic';
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
