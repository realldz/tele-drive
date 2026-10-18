import 'reflect-metadata';
import { AuthController } from './auth.controller';
import { IS_PUBLIC_KEY } from './public.decorator';

/**
 * Regression guard cho thứ tự decorator trong AuthController.
 *
 * JwtAuthGuard là APP_GUARD toàn cục (app.module / core-server.module /
 * transfer-server.module), nên mỗi route public phải giữ @Public() nằm NGAY
 * TRÊN handler của chính nó. Chèn một route mới vào sau một @Public() đang có
 * sẽ "cướp" decorator đó: route mới thành public còn route cũ rơi vào JWT guard
 * và trả 401 cho mọi request.
 *
 * Lỗi này từng xảy ra với POST /auth/login: mọi lần đăng nhập đều 401 dù mật
 * khẩu đúng, kể cả sau khi reset mật khẩu trong DB.
 */
describe('AuthController public metadata', () => {
  const isPublic = (method: keyof AuthController): boolean | undefined => {
    const descriptor = Object.getOwnPropertyDescriptor(
      AuthController.prototype,
      method,
    );
    return Reflect.getMetadata(IS_PUBLIC_KEY, descriptor?.value as object) as
      | boolean
      | undefined;
  };

  it('keeps POST /auth/login public so the global JWT guard is skipped', () => {
    expect(isPublic('login')).toBe(true);
  });

  it('keeps POST /auth/register public', () => {
    expect(isPublic('register')).toBe(true);
  });

  it('keeps GET /auth/registration-status public', () => {
    expect(isPublic('registrationStatus')).toBe(true);
  });

  it('leaves GET /auth/profile behind the JWT guard', () => {
    expect(isPublic('getProfile')).toBeUndefined();
  });
});
