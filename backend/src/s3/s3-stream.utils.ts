import type { Readable } from 'stream';
import type { S3AuthenticatedRequest } from '../common/types/request';
import { AwsChunkedDecodeStream } from './aws-chunked-decode.stream';

export function isAwsChunkedRequest(req: S3AuthenticatedRequest): boolean {
  const contentEncoding = String(req.headers['content-encoding'] || '').toLowerCase();
  const contentSha256 = String(req.headers['x-amz-content-sha256'] || '').toUpperCase();

  return contentEncoding.includes('aws-chunked')
    || contentSha256.startsWith('STREAMING-AWS4-HMAC-SHA256-PAYLOAD')
    || req.headers['x-amz-decoded-content-length'] !== undefined;
}

export function getS3RequestContentLength(req: S3AuthenticatedRequest): number {
  const decodedContentLength = req.headers['x-amz-decoded-content-length'];
  if (decodedContentLength !== undefined) {
    const value = parseInt(String(decodedContentLength), 10);
    if (Number.isFinite(value) && value >= 0) return value;
  }

  const contentLength = parseInt(String(req.headers['content-length'] || '0'), 10);
  return Number.isFinite(contentLength) && contentLength >= 0 ? contentLength : 0;
}

export function wrapRequestStream(req: S3AuthenticatedRequest): {
  stream: Readable;
  contentLength: number;
  decoder?: AwsChunkedDecodeStream;
} {
  const contentLength = getS3RequestContentLength(req);

  if (!isAwsChunkedRequest(req)) {
    return {
      stream: req as unknown as Readable,
      contentLength,
    };
  }

  const decoder = new AwsChunkedDecodeStream();
  return {
    stream: (req as unknown as Readable).pipe(decoder),
    contentLength,
    decoder,
  };
}
