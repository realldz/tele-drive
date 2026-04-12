import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import { getClientIp } from '../utils/get-client-ip';

interface AuthRequest extends Request {
  user?: Record<string, unknown>;
}

@Injectable()
export class RequestLoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger(RequestLoggingInterceptor.name);

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const ctx = context.switchToHttp();
    const req = ctx.getRequest<AuthRequest>();
    const res = ctx.getResponse<Response>();

    if (!req || !req.url) {
      return next.handle();
    }

    const requestId = req.requestId || 'unknown';
    const method = req.method;
    const url = req.originalUrl || req.url;
    const ip = getClientIp(req);
    const userAgent = (req.headers['user-agent'] as string) || '';

    const userId =
      req.user && typeof req.user['userId'] === 'string'
        ? req.user['userId']
        : '';
    const username =
      req.user && typeof req.user['username'] === 'string'
        ? req.user['username']
        : '';

    const startTime = Date.now();

    this.logger.verbose({
      requestId,
      method,
      url: `${method} ${url}`,
      ip,
      userAgent,
      userId: userId || undefined,
      username: username || undefined,
    });

    return next.handle().pipe(
      tap({
        next: () => {
          const statusCode = res.statusCode ?? 200;
          const duration = Date.now() - startTime;
          const contentLength = res.getHeader?.('content-length') as
            | string
            | undefined;

          this.logger.log({
            requestId,
            method,
            url: `${method} ${url}`,
            statusCode,
            durationMs: duration,
            contentLength: contentLength ? `${contentLength}B` : '',
            userId: userId || undefined,
          });
        },
        error: (error: Error) => {
          const statusCode = res?.statusCode ?? 500;
          const duration = Date.now() - startTime;

          this.logger.error({
            requestId,
            method,
            url: `${method} ${url}`,
            statusCode,
            error: error.message,
            durationMs: duration,
            userId: userId || undefined,
            stack: error.stack,
          });
        },
      }),
    );
  }
}
