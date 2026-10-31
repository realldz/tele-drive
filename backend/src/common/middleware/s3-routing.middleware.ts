import { Logger } from '@nestjs/common';
import type { RequestHandler } from 'express';

/** Dedicated S3 hosts use bare bucket paths; originalUrl remains signed. */
export function createS3RoutingMiddleware(domain: string): RequestHandler {
  const hostname = domain.trim().toLowerCase();
  const logger = new Logger('S3Routing');
  if (hostname) logger.log(`S3 bare-bucket routing enabled for ${hostname}`);
  return (req, _res, next) => {
    const host = String(req.headers.host || '')
      .toLowerCase()
      .split(':')[0];
    if (hostname && host === hostname) {
      const url = req.url || '/';
      const queryIndex = url.indexOf('?');
      const path = queryIndex < 0 ? url : url.slice(0, queryIndex);
      const query = queryIndex < 0 ? '' : url.slice(queryIndex);
      // 's3' is a valid bucket, never an already-applied routing prefix here.
      req.url = `/s3${path === '/' ? '' : path}${query}`;
    } else if (/^\/api\/s3(?:[/?]|$)/.test(req.url)) {
      req.url = req.url.replace(/^\/api\/s3/, '/s3');
    }
    next();
  };
}
