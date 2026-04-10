import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { CryptoService } from '../../crypto/crypto.service';
import type { Request } from 'express';

/**
 * StreamCookieGuard — verifies the `stream_token` cookie on stream endpoints.
 *
 * On success, attaches `req.streamUser = { sub, exp }` so controllers can
 * read the authenticated subject without re-verifying.
 *
 * Replaces the duplicated private `verifyStreamCookie()` method that was
 * copy-pasted in both FileController and FolderController.
 */
@Injectable()
export class StreamCookieGuard implements CanActivate {
  constructor(private readonly cryptoService: CryptoService) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context
      .switchToHttp()
      .getRequest<Request & { streamUser?: { sub: string; exp: number } }>();
    const token = req.cookies?.stream_token;
    if (!token) throw new UnauthorizedException('Stream cookie required');

    const payload = this.cryptoService.verifyStreamCookieToken(token);
    if (!payload)
      throw new UnauthorizedException('Invalid or expired stream cookie');

    req.streamUser = payload;
    return true;
  }
}
