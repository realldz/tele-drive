import { CoreAppModule } from './core-app.module';
import { bootstrapNestApp } from './bootstrap';

async function bootstrap() {
  await bootstrapNestApp(CoreAppModule, {
    appName: 'Core API',
    port: process.env.CORE_PORT ?? process.env.PORT ?? 3001,
    enableS3RawBodyRouting: false,
  });
}

bootstrap();
