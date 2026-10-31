import { Logger } from '@nestjs/common';
import type { RequestHandler } from 'express';

const S3_PRIVATE_CACHE_CONTROL = 'private, no-store';

function isPublicS3Path(path: string): boolean {
  return path === '/public' || path.startsWith('/public/');
}

function isSigV4SignedRequest(
  authorization: string | undefined,
  query: string,
): boolean {
  return (
    authorization?.startsWith('AWS4-HMAC-SHA256 ') === true ||
    /(?:^|&)X-Amz-Algorithm=AWS4-HMAC-SHA256(?:&|$)/.test(
      query.replace(/^\?/, ''),
    )
  );
}

function setPrivateS3CacheHeaders(res: Parameters<RequestHandler>[1]): void {
  res.setHeader('Cache-Control', S3_PRIVATE_CACHE_CONTROL);
  res.setHeader('CDN-Cache-Control', 'no-store');
  res.setHeader('Cloudflare-CDN-Cache-Control', 'no-store');
}

/** Dedicated S3 hosts use bare bucket paths; originalUrl remains signed. */
export function createS3RoutingMiddleware(domain: string): RequestHandler {
  const hostname = domain.trim().toLowerCase();
  const logger = new Logger('S3Routing');
  if (hostname) logger.log(`S3 bare-bucket routing enabled for ${hostname}`);
  return (req, res, next) => {
    const host = String(req.headers.host || '')
      .toLowerCase()
      .split(':')[0];
    const url = req.url || '/';
    const queryIndex = url.indexOf('?');
    const path = queryIndex < 0 ? url : url.slice(0, queryIndex);
    const query = queryIndex < 0 ? '' : url.slice(queryIndex);
    const isSigned = isSigV4SignedRequest(req.headers.authorization, query);

    if (hostname && host === hostname) {
      if (!isPublicS3Path(path) || isSigned) setPrivateS3CacheHeaders(res);
      // 's3' is a valid bucket, never an already-applied routing prefix here.
      req.url = `/s3${path === '/' ? '' : path}${query}`;
    } else if (/^\/api\/s3(?:[/?]|$)/.test(req.url)) {
      const apiS3Path = path.slice('/api/s3'.length) || '/';
      if (!isPublicS3Path(apiS3Path) || isSigned) setPrivateS3CacheHeaders(res);
      req.url = req.url.replace(/^\/api\/s3/, '/s3');
    }
    next();
  };
}
