import { Module } from '@nestjs/common';
import { FileModule } from './file/file.module';
import { S3Module } from './s3/s3.module';
import { BandwidthModule } from './common/bandwidth.module';

@Module({
  imports: [BandwidthModule, FileModule, S3Module],
  exports: [BandwidthModule, FileModule, S3Module],
})
export class TransferAppModule {}
