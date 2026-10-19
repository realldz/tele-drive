import { Module } from '@nestjs/common';
import { ClientConfigController } from './client-config.controller';

/**
 * Serves the frontend's runtime config (transfer origin + S3 host).
 *
 * Control-plane only: it reads NestJS core env (`PUBLIC_TRANSFER_URL`,
 * `S3_DOMAIN`). No providers — the values come straight from the environment.
 */
@Module({
  controllers: [ClientConfigController],
})
export class ClientConfigModule {}
