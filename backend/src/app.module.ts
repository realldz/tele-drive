import { Module } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { TelegramModule } from './telegram/telegram.module';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TelegrafModule } from 'nestjs-telegraf';
import { PrismaModule } from './prisma/prisma.module';
import { FolderModule } from './folder/folder.module';
import { FileModule } from './file/file.module';
import { AuthModule } from './auth/auth.module';
import { UserModule } from './user/user.module';
import { SettingsModule } from './settings/settings.module';
import { CryptoModule } from './crypto/crypto.module';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { StaleUploadCleanupService } from './common/stale-upload-cleanup.service';
import { BandwidthModule } from './common/bandwidth.module';
import { S3Module } from './s3/s3.module';
import { AppLoggerModule } from './common/logger/logger.module';
import { RequestLoggingInterceptor } from './common/interceptors/request-logging.interceptor';
import { AdminLogModule } from './admin-log/admin-log.module';

@Module({
  imports: [
    AppLoggerModule,
    ConfigModule.forRoot({ isGlobal: true }),
    ScheduleModule.forRoot(),
    ThrottlerModule.forRoot([{ ttl: 60000, limit: 60 }]),
    TelegrafModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: (configService: ConfigService) => ({
        token: configService.get<string>('TELEGRAM_BOT_TOKEN') || '',
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
    AuthModule,
    FolderModule,
    FileModule,
    UserModule,
    SettingsModule,
    CryptoModule,
    BandwidthModule,
    S3Module,
    AdminLogModule,
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
    StaleUploadCleanupService,
  ],
})
export class AppModule {}
