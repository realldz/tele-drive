import { Module } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TelegrafModule } from 'nestjs-telegraf';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { TelegramModule } from './telegram/telegram.module';
import { PrismaModule } from './prisma/prisma.module';
import { CryptoModule } from './crypto/crypto.module';
import { BandwidthModule } from './common/bandwidth.module';
import { AppLoggerModule } from './common/logger/logger.module';
import { RequestLoggingInterceptor } from './common/interceptors/request-logging.interceptor';
import { CoreAppModule } from './core-app.module';
import { RedisModule } from './redis';
import { QueueModule } from './queue';
import { DownloadZipModule } from './download-zip/download-zip.module';
import { S3Module } from './s3/s3.module';
import { GrpcCoreModule } from './grpc/grpc-core.module';
import { CacheModule } from './cache/cache.module';
import { QuotaSyncService } from './common/quota-sync.service';

@Module({
  imports: [
    AppLoggerModule,
    GrpcCoreModule,
    CacheModule,
    ConfigModule.forRoot({ isGlobal: true }),
    ScheduleModule.forRoot(),
    ThrottlerModule.forRoot([{ ttl: 60000, limit: 60 }]),
    RedisModule,
    QueueModule,
    TelegrafModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: (configService: ConfigService) => ({
        token: configService.get<string>('TELEGRAM_BOT_TOKEN') || '',
        launchOptions: false,
        options: {
          telegram: {
            apiRoot:
              configService.get<string>('TELEGRAM_API_ROOT') ||
              'https://api.telegram.org',
          },
        },
      }),
      inject: [ConfigService],
    }),
    TelegramModule,
    PrismaModule,
    CryptoModule,
    BandwidthModule,
    S3Module,
    CoreAppModule,
    DownloadZipModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    {
      provide: APP_GUARD,
      useClass: JwtAuthGuard,
    },
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
    {
      provide: APP_INTERCEPTOR,
      useClass: RequestLoggingInterceptor,
    },
    QuotaSyncService,
  ],
})
export class CoreServerModule {}
