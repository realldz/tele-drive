import { AppModule } from './app.module';
import { bootstrapNestApp } from './bootstrap';

async function bootstrap() {
  await bootstrapNestApp(AppModule, {
    appName: 'Application',
    enableS3RawBodyRouting: true,
  });
}
bootstrap();
