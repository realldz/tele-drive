import { Module } from '@nestjs/common';
import { GrpcCoreController } from './grpc-core.controller';
import { GrpcTransferModule } from './grpc-transfer.module';
import { PrismaModule } from '../prisma/prisma.module';
import { FolderModule } from '../folder/folder.module';

@Module({
  imports: [PrismaModule, FolderModule, GrpcTransferModule],
  controllers: [GrpcCoreController],
})
export class GrpcCoreModule {}
