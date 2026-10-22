import { Logger, HttpStatus } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';

/**
 * Rejects request bodies declared as Brotli-encoded (`Content-Encoding: br`).
 *
 * CVE-2026-111497 (Node.js Brotli decoder out-of-bounds write, RCE) is reached
 * through `zlib.createBrotliDecompress()`, which `body-parser` calls for every
 * `Content-Encoding: br` body. Nest runs body parsing as middleware, i.e.
 * *before* the global JWT guard, so the decoder would decode unauthenticated,
 * attacker-supplied bytes on public routes (login/register/config).
 *
 * `/s3` routes are exempt on purpose: they never go through body parsing (raw
 * stream uploads) and S3 clients legitimately send `Content-Encoding` as object
 * metadata, including `br`. gzip/deflate bodies stay supported.
 *
 * Node >= 22.23.4 / 24.22.1 / 26.12.1 contain the upstream fix; this guard is
 * defence in depth for images and dev machines still on an unpatched runtime.
 */
const BROTLI_TOKENS = new Set(['br', 'brotli']);

const logger = new Logger('BrotliRequestGuard');

function isS3Path(req: Request): boolean {
  // Check both urls: the S3 rewrites mutate `req.url` while `originalUrl` keeps
  // what the client signed (`/api/s3/...` or the bare S3 domain path).
  return [req.url, req.originalUrl].some((value) => {
    const path = (value || '').split('?')[0];
    return (
      path === '/s3' ||
      path.startsWith('/s3/') ||
      path === '/api/s3' ||
      path.startsWith('/api/s3/')
    );
  });
}

function declaresBrotli(contentEncoding: string): boolean {
  return contentEncoding
    .split(',')
    .map((token) => token.trim().toLowerCase())
    .filter(Boolean)
    .some((token) => BROTLI_TOKENS.has(token));
}

export function rejectBrotliRequestEncoding(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const header = req.headers['content-encoding'];
  const contentEncoding = Array.isArray(header)
    ? header.join(',')
    : header || '';

  if (!contentEncoding || !declaresBrotli(contentEncoding)) {
    next();
    return;
  }

  if (isS3Path(req)) {
    next();
    return;
  }

  logger.warn(
    `[${req.requestId}] rejected brotli-encoded request body: ${req.method} ${req.originalUrl || req.url} (content-encoding: ${contentEncoding}, ip: ${req.ip})`,
  );

  res.status(HttpStatus.UNSUPPORTED_MEDIA_TYPE).json({
    statusCode: HttpStatus.UNSUPPORTED_MEDIA_TYPE,
    message: 'Brotli-encoded request bodies are not accepted',
    timestamp: new Date().toISOString(),
    path: req.originalUrl || req.url,
  });
}
