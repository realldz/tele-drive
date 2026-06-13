import { Module } from '@nestjs/common';
import { GrpcCoreController } from './grpc-core.controller';
import { GrpcTransferModule } from './grpc-transfer.module';
import { PrismaModule } from '../prisma/prisma.module';
import { FolderModule } from '../folder/folder.module';
import { DownloadZipModule } from '../download-zip/download-zip.module';

@Module({
  imports: [PrismaModule, FolderModule, GrpcTransferModule, DownloadZipModule],
  controllers: [GrpcCoreController],
})
export class GrpcCoreModule {}
