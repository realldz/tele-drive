import { Module } from '@nestjs/common';
import { DownloadZipController } from './download-zip.controller';
import { DownloadZipService } from './download-zip.service';
import { DownloadZipProcessor } from './download-zip.processor';
import { TelegramModule } from '../telegram/telegram.module';
import { CryptoModule } from '../crypto/crypto.module';
import { SettingsModule } from '../settings/settings.module';
import { TempStorageModule } from '../common/temp-storage/temp-storage.module';
import { QueueModule } from '../queue';
import { FileModule } from '../file/file.module';
import { FolderModule } from '../folder/folder.module';
import { BandwidthModule } from '../common/bandwidth.module';

@Module({
  imports: [
    TelegramModule,
    CryptoModule,
    SettingsModule,
    TempStorageModule,
    QueueModule,
    FileModule,
    FolderModule,
    BandwidthModule,
  ],
  controllers: [DownloadZipController],
  providers: [DownloadZipService, DownloadZipProcessor],
  exports: [DownloadZipService],
})
export class DownloadZipModule {}
