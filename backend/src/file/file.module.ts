import { Module } from '@nestjs/common';
import { FileController } from './file.controller';
import { TelegramModule } from '../telegram/telegram.module';
import { CryptoModule } from '../crypto/crypto.module';
import { SettingsModule } from '../settings/settings.module';
import { AuthModule } from '../auth/auth.module';
import { NameConflictModule } from '../common/name-conflict.module';
import { TrashCleanupService } from '../common/trash-cleanup.service';
import { TransferReadService } from './transfer-read.service';
import { UploadSessionService } from './upload-session.service';
import { FileMetadataService } from './file-metadata.service';
import { FileLifecycleService } from './file-lifecycle.service';
import { FileStorageUploadService } from './file-storage-upload.service';
import { FileMaintenanceService } from './file-maintenance.service';
import { TempStorageModule } from '../common/temp-storage/temp-storage.module';
import { UploadBufferService } from './upload-buffer.service';
import { UploadQueueProcessor } from './upload-queue.processor';
import { QueueModule } from '../queue';

@Module({
  imports: [
    TelegramModule,
    CryptoModule,
    SettingsModule,
    AuthModule,
    NameConflictModule,
    TempStorageModule,
    QueueModule,
  ],
  controllers: [FileController],
  providers: [
    FileMetadataService,
    FileLifecycleService,
    FileStorageUploadService,
    FileMaintenanceService,
    TrashCleanupService,
    TransferReadService,
    UploadSessionService,
    UploadBufferService,
    UploadQueueProcessor,
  ],
  exports: [
    FileMetadataService,
    FileLifecycleService,
    FileStorageUploadService,
    FileMaintenanceService,
    TransferReadService,
    UploadSessionService,
    UploadBufferService,
  ],
})
export class FileModule {}
