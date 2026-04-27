import { TransferAppModule } from './transfer-app.module';
import { bootstrapNestApp } from './bootstrap';

async function bootstrap() {
  await bootstrapNestApp(TransferAppModule, {
    appName: 'Transfer API',
    port: process.env.TRANSFER_PORT ?? process.env.PORT ?? 3001,
    enableS3RawBodyRouting: true,
  });
}

bootstrap();
