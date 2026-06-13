import { Module } from '@nestjs/common';
import { GrpcCoreController } from './grpc-core.controller';
import { GrpcTransferModule } from './grpc-transfer.module';
import { PrismaModule } from '../prisma/prisma.module';
import { FolderModule } from '../folder/folder.module';
import { DownloadZipModule } from '../download-zip/download-zip.module';
import { S3AuthService } from '../s3/s3-auth.service';

@Module({
  imports: [PrismaModule, FolderModule, GrpcTransferModule, DownloadZipModule],
  controllers: [GrpcCoreController],
  // S3AuthService is provided here (not via S3Module import) so the gRPC handler
  // can decrypt secrets without dragging in S3's full controller/guard graph.
  providers: [S3AuthService],
})
export class GrpcCoreModule {}
