import { ValidationPipe, type Type } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { WINSTON_MODULE_NEST_PROVIDER } from 'nest-winston';
import helmet from 'helmet';
import * as bodyParser from 'body-parser';
import cookieParser from 'cookie-parser';
import { requestIdMiddleware } from './common/middleware/request-id.middleware';
import { GlobalExceptionFilter } from './common/filters/global-exception.filter';

type BootstrapOptions = {
  appName: string;
  port?: number | string;
  enableS3RawBodyRouting?: boolean;
};

export async function bootstrapNestApp(
  rootModule: Type<unknown>,
  options: BootstrapOptions,
) {
  const isProduction = process.env.NODE_ENV === 'production';

  (BigInt.prototype as any).toJSON = function () {
    return this.toString();
  };

  const app = await NestFactory.create(rootModule, {
    bodyParser: false,
    bufferLogs: true,
  });

  const winstonLogger = app.get(WINSTON_MODULE_NEST_PROVIDER);
  app.useLogger(winstonLogger);

  app.use(requestIdMiddleware);
  app.useGlobalFilters(new GlobalExceptionFilter());

  const expressApp = app.getHttpAdapter().getInstance();
  expressApp.set('trust proxy', 1);

  if (options.enableS3RawBodyRouting) {
    expressApp.use((req: any, _res: any, next: any) => {
      if (req.url.startsWith('/api/s3/') || req.url === '/api/s3') {
        req.url = req.url.replace(/^\/api\/s3/, '/s3');
      }
      next();
    });

    expressApp.use((req: any, res: any, next: any) => {
      if (req.path && (req.path.startsWith('/s3/') || req.path === '/s3')) {
        return next();
      }
      bodyParser.json({ limit: '10mb' })(req, res, (err: any) => {
        if (err) return next(err);
        bodyParser.urlencoded({ extended: true, limit: '10mb' })(
          req,
          res,
          next,
        );
      });
    });
  } else {
    expressApp.use(bodyParser.json({ limit: '10mb' }));
    expressApp.use(bodyParser.urlencoded({ extended: true, limit: '10mb' }));
  }

  app.use(
    helmet({
      crossOriginResourcePolicy: { policy: 'cross-origin' },
    }),
  );

  app.use(cookieParser());

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  const corsOrigin = process.env.CORS_ORIGIN;
  app.enableCors({
    origin: corsOrigin || true,
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE',
    credentials: true,
    exposedHeaders: ['X-Bandwidth-Reset', 'X-Request-ID'],
  });

  const port = options.port ?? process.env.PORT ?? 3001;
  await app.listen(port);

  winstonLogger.log(
    `${options.appName} started on port ${port} [${isProduction ? 'PRODUCTION' : 'DEVELOPMENT'}]`,
    'Bootstrap',
  );

  return app;
}
