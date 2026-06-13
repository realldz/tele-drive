import { CoreServerModule } from './core-server.module';
import { bootstrapNestApp } from './bootstrap';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import { join } from 'path';
import { Logger } from '@nestjs/common';

async function bootstrap() {
  const app = await bootstrapNestApp(CoreServerModule, {
    appName: 'Core API',
    port: process.env.CORE_PORT ?? process.env.PORT ?? 3001,
    enableS3RawBodyRouting: true,
  });

  const logger = new Logger('Bootstrap');

  app.connectMicroservice<MicroserviceOptions>({
    transport: Transport.GRPC,
    options: {
      package: ['core'],
      protoPath: [join(__dirname, 'grpc/proto/core.proto')],
      url: `0.0.0.0:${process.env.GRPC_PORT || '50051'}`,
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
