import { TransferServerModule } from './transfer-server.module';
import { bootstrapNestApp } from './bootstrap';

async function bootstrap() {
  await bootstrapNestApp(TransferServerModule, {
    appName: 'Transfer API',
    port: process.env.TRANSFER_PORT ?? process.env.PORT ?? 3001,
    enableS3RawBodyRouting: true,
  });
}

bootstrap();
