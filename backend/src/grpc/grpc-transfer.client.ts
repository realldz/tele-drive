import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import * as microservices from '@nestjs/microservices';
import { join } from 'path';
import { Observable, lastValueFrom } from 'rxjs';
import { buildClientCredentials } from './grpc-tls';

// mTLS when GRPC_TLS_* are set: NestJS presents its leaf cert and verifies the
// Go server against the internal CA. The dns:/// authority (backend-transfer)
// must match the Go cert SAN for hostname verification. Independent of the
// round_robin LB below — credentials are a transport-layer concern. null →
// plaintext fallback for local dev.
const grpcTransferCredentials = buildClientCredentials();

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
      ...(grpcTransferCredentials
        ? { credentials: grpcTransferCredentials }
        : {}),
      keepalive: {
        keepaliveTimeMs: 30000,
        keepaliveTimeoutMs: 10000,
        keepalivePermitWithoutCalls: 1,
      },
      // Client-side load balancing across multiple Go transfer instances.
      // Requires a dns:/// target (e.g. dns:///backend-transfer:50051) so the
      // resolver returns every A-record; round_robin then spreads RPCs over all
      // READY subchannels instead of pinning one backend via pick_first.
      channelOptions: {
        'grpc.service_config': JSON.stringify({
          loadBalancingConfig: [{ round_robin: {} }],
        }),
        'grpc.dns_min_time_between_resolutions_ms': 5000,
        // Pin TLS hostname verification to the logical service name, decoupling
        // it from the dial address. In single-host compose the dns:/// authority
        // is already "backend-transfer" (matches the leaf cert SAN); but in the
        // split-host topology GO_TRANSFER_GRPC_URL dials GO_HOST (an IP/DNS that
        // is NOT in the SAN), so without this override the handshake would fail.
        // Mirrors the Go client, which pins ServerName "backend-core". Keeps one
        // service cert valid across every Go host/replica — no per-host SANs.
        'grpc.ssl_target_name_override': 'backend-transfer',
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
