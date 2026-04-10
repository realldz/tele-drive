import { Module } from '@nestjs/common';
import { FileService } from './file.service';
import { FileController } from './file.controller';
import { TelegramModule } from '../telegram/telegram.module';
import { CryptoModule } from '../crypto/crypto.module';
import { SettingsModule } from '../settings/settings.module';
import { AuthModule } from '../auth/auth.module';
import { NameConflictModule } from '../common/name-conflict.module';
import { TrashCleanupService } from '../common/trash-cleanup.service';

@Module({
  imports: [
    TelegramModule,
    CryptoModule,
    SettingsModule,
    AuthModule,
    NameConflictModule,
  ],
  controllers: [FileController],
  providers: [FileService, TrashCleanupService],
  exports: [FileService],
})
export class FileModule {}
