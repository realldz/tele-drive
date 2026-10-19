import { Controller, Get, Header, Logger } from '@nestjs/common';
import { Public } from '../auth/public.decorator';
import { getPublicTransferOrigin } from '../common/transfer-url.util';
import { getPublicS3Domain } from './client-config.util';

export interface ClientConfigResponse {
  /** Data-plane origin (dedicated transfer domain), or null = same origin. */
  transferUrl: string | null;
  /** S3 host advertised to clients, or null = S3 not configured. */
  s3Domain: string | null;
}

/**
 * Public runtime config for the frontend.
 *
 * Replaces the build-time `NEXT_PUBLIC_TRANSFER_URL` / `NEXT_PUBLIC_S3_DOMAIN`
 * bundle values: the browser fetches this once at boot (`ensureClientConfig()`
 * in `frontend/src/lib/api/client-config.ts`) so enabling the dedicated
 * transfer/S3 domains no longer requires rebuilding the frontend image.
 *
 * Reachable at `/api/v1/client-config` through the edge nginx (`location /api/`
 * → backend-core), i.e. always on the control-plane origin the frontend already
 * knows via `NEXT_PUBLIC_API_URL` — no dedicated nginx route.
 */
@Controller('client-config')
export class ClientConfigController {
  private readonly logger = new Logger(ClientConfigController.name);

  @Public()
  @Get()
  // Config flips must not be pinned by a client/CDN cache.
  @Header('Cache-Control', 'no-store')
  getClientConfig(): ClientConfigResponse {
    const transferUrl = getPublicTransferOrigin();
    const s3Domain = getPublicS3Domain();

    // Debug on purpose: one call per page load, the value is static per deploy.
    this.logger.debug(
      `client-config served: transferUrl=${transferUrl ?? '(unset)'} s3Domain=${s3Domain ?? '(unset)'}`,
    );

    return { transferUrl, s3Domain };
  }
}
