import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { AppModule } from './app.module';
import * as bodyParser from 'body-parser';

async function bootstrap() {
  const isProduction = process.env.NODE_ENV === 'production';

  // Fix BigInt serialization issue with Prisma
  (BigInt.prototype as any).toJSON = function () {
    return this.toString();
  };

  // Disable the built-in body parser so S3 routes can stream raw bodies
  // without NestJS buffering them into req.body first.
  // We re-apply body parsing only for non-S3 routes via middleware below.
  const app = await NestFactory.create(AppModule, {
    bodyParser: false,
    logger: isProduction
      ? ['error', 'warn', 'log']
      : ['error', 'warn', 'log', 'debug', 'verbose'],
  });

  // Apply body parsers only to non-S3 routes.
  // S3 routes stream the raw body themselves (PutObject, UploadPart, etc.)
  const expressApp = app.getHttpAdapter().getInstance();
  expressApp.use((req: any, res: any, next: any) => {
    if (req.path && req.path.startsWith('/s3/')) {
      // Skip body parsing for S3 — controller reads raw stream
      return next();
    }
    // Apply JSON + urlencoded body parsers for all other routes
    bodyParser.json({ limit: '10mb' })(req, res, (err: any) => {
      if (err) return next(err);
      bodyParser.urlencoded({ extended: true, limit: '10mb' })(req, res, next);
    });
  });

  // Cho phép gọi API từ Next.js
  app.enableCors({
    origin: true,
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE',
    credentials: true,
  });

  // Tránh xung đột cổng với Next.js
  const port = process.env.PORT ?? 3001;
  await app.listen(port);

  const logger = new Logger('Bootstrap');
  logger.log(`Application started on port ${port} [${isProduction ? 'PRODUCTION' : 'DEVELOPMENT'}]`);
}
bootstrap();
