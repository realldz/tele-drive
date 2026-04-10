import {
  WinstonModuleOptions,
  utilities as nestWinstonModuleUtilities,
} from 'nest-winston';
import type TransportType from 'winston-transport';
import DailyRotateFile from 'winston-daily-rotate-file';
import * as winston from 'winston';
import * as path from 'path';

function getLogDir(): string {
  return process.env.LOG_DIR || path.join(__dirname, '..', '..', '..', '.logs');
}

function getLogLevel(): string {
  return (
    process.env.LOG_LEVEL ||
    (process.env.NODE_ENV === 'production' ? 'info' : 'debug')
  );
}

function createConsoleTransport(): TransportType {
  const isProd = process.env.NODE_ENV === 'production';

  const format = isProd
    ? winston.format.json()
    : winston.format.combine(
        winston.format.timestamp(),
        winston.format.ms(),
        nestWinstonModuleUtilities.format.nestLike('TeleDrive', {
          colors: true,
          prettyPrint: true,
          processId: true,
          appName: true,
        }),
      );

  return new winston.transports.Console({
    level: getLogLevel(),
    format,
  });
}

function createDailyRotateFileTransport(): TransportType {
  return new DailyRotateFile({
    dirname: getLogDir(),
    filename: 'combined-%DATE%.log',
    datePattern: 'YYYY-MM-DD',
    zippedArchive: true,
    maxSize: '10m',
    maxFiles: '14d',
    level: getLogLevel(),
    format: winston.format.combine(
      winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
      winston.format.errors({ stack: true }),
      winston.format.json(),
    ),
  });
}

function createErrorFileTransport(): TransportType {
  return new DailyRotateFile({
    dirname: getLogDir(),
    filename: 'error-%DATE%.log',
    datePattern: 'YYYY-MM-DD',
    zippedArchive: true,
    maxSize: '10m',
    maxFiles: '14d',
    level: 'error',
    format: winston.format.combine(
      winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
      winston.format.errors({ stack: true }),
      winston.format.json(),
    ),
  });
}

export const winstonConfig: WinstonModuleOptions = {
  level: getLogLevel(),
  transports: [
    createConsoleTransport(),
    createDailyRotateFileTransport(),
    createErrorFileTransport(),
  ],
};
