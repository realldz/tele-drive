import { CoreServerModule } from './core-server.module';
import { bootstrapNestApp } from './bootstrap';

async function bootstrap() {
  await bootstrapNestApp(CoreServerModule, {
    appName: 'Core API',
    port: process.env.CORE_PORT ?? process.env.PORT ?? 3001,
    enableS3RawBodyRouting: false,
  });
}

bootstrap();
