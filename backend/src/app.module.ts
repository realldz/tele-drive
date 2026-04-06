import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
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
import { TrashCleanupService } from './common/trash-cleanup.service';
import { StaleUploadCleanupService } from './common/stale-upload-cleanup.service';
import { BandwidthModule } from './common/bandwidth.module';
import { S3Module } from './s3/s3.module';

@Module({
  imports: [
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
    TrashCleanupService,
    StaleUploadCleanupService,
  ],
})
export class AppModule {}
