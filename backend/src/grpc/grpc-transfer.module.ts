import { Module } from '@nestjs/common';
import { GrpcTransferClient } from './grpc-transfer.client';

@Module({
  providers: [GrpcTransferClient],
  exports: [GrpcTransferClient],
})
export class GrpcTransferModule {}
