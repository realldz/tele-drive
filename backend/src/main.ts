import { NestFactory } from '@nestjs/core';
import { Logger, ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';
import helmet from 'helmet';
import * as bodyParser from 'body-parser';
import cookieParser from 'cookie-parser';

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

  // Trust nginx reverse proxy so req.ip returns the real client IP
  expressApp.set('trust proxy', 1);

  // Normalize /api/s3 → /s3 for NestJS route matching.
  // req.originalUrl keeps the full /api/s3/... path so SigV4 validation works.
  expressApp.use((req: any, _res: any, next: any) => {
    if (req.url.startsWith('/api/s3/') || req.url === '/api/s3') {
      req.url = req.url.replace(/^\/api\/s3/, '/s3');
    }
    next();
  });

  expressApp.use((req: any, res: any, next: any) => {
    if (req.path && (req.path.startsWith('/s3/') || req.path === '/s3')) {
      // Skip body parsing for S3 — controller reads raw stream
      return next();
    }
    // Apply JSON + urlencoded body parsers for all other routes
    bodyParser.json({ limit: '10mb' })(req, res, (err: any) => {
      if (err) return next(err);
      bodyParser.urlencoded({ extended: true, limit: '10mb' })(req, res, next);
    });
  });

  // Security headers
  app.use(
    helmet({
      crossOriginResourcePolicy: { policy: 'cross-origin' },
    }),
  );

  // Cookie parser — cần cho stream_token cookie
  app.use(cookieParser());

  // Global validation pipe — reject unknown/invalid fields
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  // CORS
  const corsOrigin = process.env.CORS_ORIGIN;
  app.enableCors({
    origin: corsOrigin || true,
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE',
    credentials: true,
    exposedHeaders: ['X-Bandwidth-Reset'],
  });

  const port = process.env.PORT ?? 3001;
  await app.listen(port);

  const logger = new Logger('Bootstrap');
  logger.log(
    `Application started on port ${port} [${isProduction ? 'PRODUCTION' : 'DEVELOPMENT'}]`,
  );
}
bootstrap();
