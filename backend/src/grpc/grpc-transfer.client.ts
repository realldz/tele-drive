import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import * as microservices from '@nestjs/microservices';
import { join } from 'path';
import { Observable, lastValueFrom } from 'rxjs';

interface TransferService {
  flushAndConfirm(data: { fileId: string }): Observable<{
    allComplete: boolean;
    totalChunks: number;
    completedChunks: number;
    receivedChunks: number;
    allReceived: boolean;
    chunks: Array<{
      chunkIndex: number;
      telegramFileId: string;
      telegramMessageId: number;
      botId: number;
      encryptionIv: string;
      size: number;
      etag: string;
    }>;
  }>;
  ping(data: Record<string, never>): Observable<{ timestamp: number }>;
  enqueueBufferedUpload(data: {
    fileId: string;
    tempStorageKey: string;
    userId: string;
    isChunk: boolean;
    chunkIndex: number;
    size: number;
  }): Observable<{ accepted: boolean; reason: string }>;
}

@Injectable()
export class GrpcTransferClient implements OnModuleInit {
  private readonly logger = new Logger(GrpcTransferClient.name);
  private transferService!: TransferService;

  @microservices.Client({
    transport: microservices.Transport.GRPC,
    options: {
      package: 'transfer',
      protoPath: join(__dirname, 'proto/transfer.proto'),
      url: process.env.GO_TRANSFER_GRPC_URL || 'localhost:50051',
      keepalive: {
        keepaliveTimeMs: 30000,
        keepaliveTimeoutMs: 10000,
        keepalivePermitWithoutCalls: 1,
      },
    },
  })
  private grpcClient!: microservices.ClientGrpc;

  onModuleInit() {
    this.transferService =
      this.grpcClient.getService<TransferService>('TransferService');
    this.logger.log('gRPC TransferService client initialized');
  }

  async ping(): Promise<{ timestamp: number }> {
    return lastValueFrom(this.transferService.ping({}));
  }

  async flushAndConfirm(fileId: string) {
    return lastValueFrom(this.transferService.flushAndConfirm({ fileId }));
  }

  async enqueueBufferedUpload(data: {
    fileId: string;
    tempStorageKey: string;
    userId: string;
    isChunk: boolean;
    chunkIndex: number;
    size: number;
  }): Promise<{ accepted: boolean; reason: string }> {
    return lastValueFrom(this.transferService.enqueueBufferedUpload(data));
  }
}
