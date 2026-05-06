import {
  Controller,
  Logger,
  Get,
  Head,
  Param,
  Req,
  Res,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { S3Service } from './s3.service';
import { S3PublicGuard } from './s3-public.guard';
import { TransferReadService } from '../file/transfer-read.service';
import { Public } from '../auth/public.decorator';
import { SkipThrottle } from '@nestjs/throttler';
import { BandwidthInterceptor } from '../common/bandwidth.interceptor';
import type { S3AuthenticatedRequest } from '../common/types/request';
import type { Response } from 'express';
import * as crypto from 'crypto';

/**
 * S3PublicController — S3 public access (không cần AWS Signature V4).
 *
 * URL format: /s3/public/{userId}/{bucket}/{key}
 *
 * Routes:
 *   GET  /s3/public/:userId/:bucket          → ListObjectsV2
 *   GET  /s3/public/:userId/:bucket/*key     → GetObject
 *   HEAD /s3/public/:userId/:bucket/*key     → HeadObject
 */
@Public()
@SkipThrottle()
@UseGuards(S3PublicGuard)
@Controller('public')
export class S3PublicController {
  private readonly logger = new Logger(S3PublicController.name);

  constructor(
    private readonly s3Service: S3Service,
    private readonly transferReadService: TransferReadService,
  ) {}

  // ---------------------------------------------------------------------------
  // GET /s3/public/:userId/:bucket → ListObjectsV2
  // ---------------------------------------------------------------------------

  @Get(':userId/:bucket')
  async listObjects(
    @Param('userId') userId: string,
    @Param('bucket') bucket: string,
    @Req() req: S3AuthenticatedRequest,
    @Res() res: Response,
  ) {
    this.logger.debug(`S3 Public ListObjects: ${userId}, ${bucket}`);

    const prefix = this.qstr(req.query['prefix']);
    const delimiter = this.qstr(req.query['delimiter']);
    const encodingType = this.qstr(req.query['encoding-type']);
    const maxKeys = Math.min(
      parseInt(this.qstr(req.query['max-keys']) || '1000', 10),
      1000,
    );

    this.setRequestId(res);
    try {
      const { objects, commonPrefixes } =
        await this.s3Service.listObjectsPublic(
          userId,
          bucket,
          prefix,
          delimiter || undefined,
          maxKeys,
        );
      const isTruncated = objects.length >= maxKeys;
      const xml = this.s3Service.buildListObjectsV2Xml(
        bucket,
        objects,
        commonPrefixes,
        prefix,
        delimiter,
        maxKeys,
        isTruncated,
        encodingType,
      );

      res.setHeader('Content-Type', 'application/xml');
      res.status(200).send(xml);
    } catch (err: unknown) {
      this.sendS3Error(res, err);
    }
  }

  // ---------------------------------------------------------------------------
  // GET /s3/public/:userId/:bucket/*key → GetObject
  // ---------------------------------------------------------------------------

  @UseInterceptors(BandwidthInterceptor)
  @Get(':userId/:bucket/*key')
  async getObject(
    @Param('userId') userId: string,
    @Param('bucket') bucket: string,
    @Param() params: Record<string, string>,
    @Req() req: S3AuthenticatedRequest,
    @Res() res: Response,
  ) {
    this.logger.debug(
      `S3 Public GetObject: ${userId}, ${bucket}, ${JSON.stringify(params)}`,
    );
    const key = this.getObjectKey(bucket, params, req);

    this.setRequestId(res);
    this.logger.log(
      `S3 Public GetObject: s3://${bucket}/${key} (userId: ${userId})`,
    );

    try {
      const file = await this.s3Service.findObjectPublic(userId, bucket, key);
      const downloadInfo = this.transferReadService.getDownloadMetadata(file);
      const lastModified = file.createdAt.toUTCString();

      const etag = file.etag || `"${file.id}"`;
      res.setHeader(
        'Content-Type',
        file.mimeType || 'application/octet-stream',
      );
      res.setHeader('Content-Length', file.size.toString());
      res.setHeader('ETag', etag);
      res.setHeader('Last-Modified', lastModified);
      res.setHeader('Accept-Ranges', 'bytes');

      const rangeHeader = req.headers['range'];
      if (rangeHeader) {
        return this.transferReadService.processStream(
          downloadInfo,
          rangeHeader,
          res,
        );
      }
      return this.transferReadService.processDownload(downloadInfo, res);
    } catch (err: unknown) {
      this.logger.error(
        `S3 Public GetObject error: ${err instanceof Error ? err.message : String(err)}`,
      );
      this.sendS3Error(res, err);
    }
  }

  // ---------------------------------------------------------------------------
  // HEAD /s3/public/:userId/:bucket/*key → HeadObject
  // ---------------------------------------------------------------------------

  @Head(':userId/:bucket/*key')
  async headObject(
    @Param('userId') userId: string,
    @Param('bucket') bucket: string,
    @Param() params: Record<string, string>,
    @Req() req: S3AuthenticatedRequest,
    @Res() res: Response,
  ) {
    this.logger.debug(
      `S3 Public HeadObject: ${userId}, ${bucket}, ${JSON.stringify(params)}`,
    );
    const key = this.getObjectKey(bucket, params, req);

    this.logger.log(
      `S3 Public HeadObject: s3://${bucket}/${key} (userId: ${userId})`,
    );
    this.setRequestId(res);

    try {
      const file = await this.s3Service.findObjectPublic(userId, bucket, key);
      const lastModified = file.createdAt.toUTCString();
      const etag = file.etag || `"${file.id}"`;

      res.setHeader(
        'Content-Type',
        file.mimeType || 'application/octet-stream',
      );
      res.setHeader('Content-Length', file.size.toString());
      res.setHeader('ETag', etag);
      res.setHeader('Last-Modified', lastModified);
      res.setHeader('Accept-Ranges', 'bytes');
      res.status(200).end();
    } catch (err: unknown) {
      this.logger.warn(`S3 Public HeadObject not found: s3://${bucket}/${key}`);
      const status = (err as { status?: number }).status;
      res
        .status(status || 404)
        .setHeader('Content-Type', 'application/xml')
        .send(
          this.s3Service.buildErrorXml(
            'NoSuchKey',
            'The specified key does not exist.',
          ),
        );
    }
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private setRequestId(res: Response) {
    res.setHeader(
      'x-amz-request-id',
      crypto.randomBytes(8).toString('hex').toUpperCase(),
    );
    res.setHeader('x-amz-id-2', crypto.randomBytes(16).toString('base64'));
  }

  private getObjectKey(
    bucket: string,
    params: Record<string, string>,
    req: S3AuthenticatedRequest,
  ): string {
    const fromParams = Array.isArray(params['key'])
      ? params['key'].join('/')
      : String(params['key'] || '');

    const path = req.path || '';
    const base = `/public/${params['userId'] || ''}/${bucket}/`;
    if (path.startsWith(base)) {
      const rawKey = path.substring(base.length);
      if (rawKey.length > 0) return decodeURIComponent(rawKey);
    }

    return fromParams;
  }

  private qstr(value: unknown): string {
    if (value === undefined || value === null) return '';
    if (Array.isArray(value)) return String(value[0] ?? '');
    return typeof value === 'string' ? value : '';
  }

  private sendS3Error(res: Response, err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    const explicitStatus =
      typeof err === 'object' && err !== null && 'status' in err
        ? err.status
        : undefined;
    const statusMap: Record<string, number> = {
      NoSuchBucket: 404,
      NoSuchKey: 404,
      BucketNotEmpty: 409,
      InvalidArgument: 400,
      BadDigest: 400,
      AccessDenied: 403,
      InvalidRequest: 400,
      ServiceUnavailable: 503,
      InternalError: 500,
    };

    res
      .status(
        typeof explicitStatus === 'number'
          ? explicitStatus
          : statusMap[message] || 404,
      )
      .setHeader('Content-Type', 'application/xml')
      .send(
        this.s3Service.buildErrorXml(
          message || 'InternalError',
          message || 'An internal error occurred.',
        ),
      );
  }
}
