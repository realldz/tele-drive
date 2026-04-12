import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { getClientIp } from '../utils/get-client-ip';

@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(GlobalExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request & { requestId?: string }>();

    const requestId = request.requestId || 'unknown';
    const method = request.method;
    const url = request.originalUrl || request.url;
    const ip = getClientIp(request);

    let status: number;
    let message: string;
    let stack: string | undefined;

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const responseBody = exception.getResponse();
      message =
        typeof responseBody === 'string'
          ? responseBody
          : String((responseBody as Record<string, unknown>).message) ||
            exception.message;
      stack = exception.stack;
    } else if (exception instanceof Error) {
      status = HttpStatus.INTERNAL_SERVER_ERROR;
      message = exception.message;
      stack = exception.stack;
    } else {
      status = HttpStatus.INTERNAL_SERVER_ERROR;
      message = String(exception);
      stack = undefined;
    }

    // Log full stack trace for server-side debugging
    if (status >= 500) {
      this.logger.error(
        `[${requestId}] ${method} ${url} - ${status} ${message} (ip: ${ip})`,
        stack,
      );
    } else {
      this.logger.warn(
        `[${requestId}] ${method} ${url} - ${status} ${message} (ip: ${ip})`,
      );
    }

    response.status(status).json({
      statusCode: status,
      message,
      timestamp: new Date().toISOString(),
      path: request.originalUrl || request.url,
    });
  }
}
