import { Module } from '@nestjs/common';
import { FileModule } from './file/file.module';
import { S3Module } from './s3/s3.module';
import { BandwidthModule } from './common/bandwidth.module';

import { DownloadZipModule } from './download-zip/download-zip.module';

@Module({
  imports: [BandwidthModule, FileModule, S3Module, DownloadZipModule],
  exports: [BandwidthModule, FileModule, S3Module, DownloadZipModule],
})
export class TransferAppModule {}
