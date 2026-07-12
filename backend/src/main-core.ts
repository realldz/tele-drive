import { CoreServerModule } from './core-server.module';
import { bootstrapNestApp } from './bootstrap';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import { join } from 'path';
import { Logger } from '@nestjs/common';
import { buildServerCredentials } from './grpc/grpc-tls';

async function bootstrap() {
  const app = await bootstrapNestApp(CoreServerModule, {
    appName: 'Core API',
    port: process.env.CORE_PORT ?? process.env.PORT ?? 3001,
    enableS3RawBodyRouting: true,
  });

  const logger = new Logger('Bootstrap');

  // mTLS when GRPC_TLS_* are set (every Go client must present a cert signed by
  // the internal CA); plaintext fallback for local dev. Independent of the
  // round_robin LB the Go client uses — credentials are a transport-layer concern.
  const grpcCredentials = buildServerCredentials();
  if (grpcCredentials) {
    logger.log('gRPC server mTLS enabled (client cert required)');
  } else {
    logger.warn('gRPC server running in PLAINTEXT (no GRPC_TLS_* configured)');
  }

  app.connectMicroservice<MicroserviceOptions>({
    transport: Transport.GRPC,
    options: {
      package: ['core'],
      protoPath: [join(__dirname, 'grpc/proto/core.proto')],
      url: `0.0.0.0:${process.env.GRPC_PORT || '50051'}`,
      ...(grpcCredentials ? { credentials: grpcCredentials } : {}),
      keepalive: {
        keepaliveTimeMs: 30000,
        keepaliveTimeoutMs: 10000,
        keepalivePermitWithoutCalls: 1,
        http2MaxPingsWithoutData: 0,
      },
      loader: {
        longs: String,
        enums: String,
        defaults: true,
        oneofs: true,
      },
      maxReceiveMessageLength: 10 * 1024 * 1024,
      maxSendMessageLength: 10 * 1024 * 1024,
    },
  });

  await app.startAllMicroservices();
  logger.log(`gRPC server started on port ${process.env.GRPC_PORT || '50051'}`);
}

void bootstrap();
