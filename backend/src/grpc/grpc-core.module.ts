import { Module } from '@nestjs/common';
import { GrpcCoreController } from './grpc-core.controller';
import { GrpcTransferClient } from './grpc-transfer.client';
import { PrismaModule } from '../prisma/prisma.module';
import { FolderModule } from '../folder/folder.module';

@Module({
  imports: [PrismaModule, FolderModule],
  controllers: [GrpcCoreController],
  providers: [GrpcTransferClient],
  exports: [GrpcTransferClient],
})
export class GrpcCoreModule {}
