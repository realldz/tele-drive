import { Global, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { BullModule } from '@nestjs/bullmq';

@Global()
@Module({
  imports: [
    BullModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: (config: ConfigService) => {
        const redisUrl = config.get<string>(
          'REDIS_URL',
          'redis://localhost:6379',
        );
        const parsed = new URL(redisUrl);
        const connectionOptions: {
          host: string;
          port: number;
          username?: string;
          password?: string;
          tls?: Record<string, unknown>;
        } = {
          host: parsed.hostname || 'localhost',
          port: parsed.port ? parseInt(parsed.port, 10) : 6379,
        };
        if (parsed.username) {
          connectionOptions.username = parsed.username;
        }
        if (parsed.password) {
          connectionOptions.password = decodeURIComponent(parsed.password);
        }
        if (parsed.protocol === 'rediss:') {
          connectionOptions.tls = {};
        }
        return {
          connection: connectionOptions,
        };
      },
      inject: [ConfigService],
    }),
    BullModule.registerQueue(
      { name: 'upload-dispatch' },
      { name: 'download-zip' },
    ),
  ],
  exports: [BullModule],
})
export class QueueModule {}
