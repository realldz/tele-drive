import { Module } from '@nestjs/common';
import { S3Controller } from './s3.controller';
import { S3CredentialController } from './s3-credential.controller';
import { S3PublicController } from './s3-public.controller';
import { S3Service } from './s3.service';
import { S3MultipartService } from './s3-multipart.service';
import { S3AuthService } from './s3-auth.service';
import { S3CredentialService } from './s3-credential.service';
import { S3AuthGuard } from './s3-auth.guard';
import { S3PublicGuard } from './s3-public.guard';
import { PrismaModule } from '../prisma/prisma.module';
import { FileModule } from '../file/file.module';
import { TelegramModule } from '../telegram/telegram.module';
import { CryptoModule } from '../crypto/crypto.module';
import { SettingsModule } from '../settings/settings.module';

@Module({
  imports: [
    PrismaModule,
    FileModule,
    TelegramModule,
    CryptoModule,
    SettingsModule,
  ],
  controllers: [S3PublicController, S3Controller, S3CredentialController],
  providers: [
    S3Service,
    S3MultipartService,
    S3AuthService,
    S3CredentialService,
    S3AuthGuard,
    S3PublicGuard,
  ],
  exports: [S3AuthService],
})
export class S3Module {}
