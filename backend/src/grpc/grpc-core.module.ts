import { Module } from '@nestjs/common';
import { GrpcCoreController } from './grpc-core.controller';
import { GrpcTransferClient } from './grpc-transfer.client';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  controllers: [GrpcCoreController],
  providers: [GrpcTransferClient],
  exports: [GrpcTransferClient],
})
export class GrpcCoreModule {}
