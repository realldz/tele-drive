import { Module } from '@nestjs/common';
import { GrpcCoreController } from './grpc-core.controller';
import { GrpcTransferModule } from './grpc-transfer.module';
import { PrismaModule } from '../prisma/prisma.module';
import { FolderModule } from '../folder/folder.module';
import { DownloadZipModule } from '../download-zip/download-zip.module';
import { S3AuthService } from '../s3/s3-auth.service';
import { S3Service } from '../s3/s3.service';
import { CryptoModule } from '../crypto/crypto.module';

@Module({
  imports: [
    PrismaModule,
    FolderModule,
    GrpcTransferModule,
    DownloadZipModule,
    CryptoModule,
  ],
  controllers: [GrpcCoreController],
  // S3AuthService + S3Service are provided here (not via S3Module import) so the
  // gRPC handlers can decrypt secrets and resolve bucket/key → FileRecord without
  // dragging in S3's full controller/guard graph. CacheService (S3Service dep) is
  // global. PrismaModule already imported.
  providers: [S3AuthService, S3Service],
})
export class GrpcCoreModule {}
