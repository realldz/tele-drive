import { S3AuthService } from './s3-auth.service';
import * as crypto from 'crypto';

describe('S3AuthService canonicalization', () => {
  let service: S3AuthService;

  beforeEach(() => {
    service = new S3AuthService({} as never);
  });

  it('canonicalizes object paths with spaces, unicode, plus signs, and brackets', () => {
    const req = {
      method: 'GET',
      originalUrl:
        '/s3/demo-bucket/archive/Project%20Files/Season%201/%5BClip%5D%20%E6%98%9F%E7%81%AB%20Demo%20A.mp4',
      headers: {
        host: 'localhost:3001',
        'x-amz-content-sha256': 'UNSIGNED-PAYLOAD',
        'x-amz-date': '20260501T010203Z',
      },
    };

    const canonicalRequest = (service as any).buildCanonicalRequest(req, [
      'host',
      'x-amz-content-sha256',
      'x-amz-date',
    ]);

    const [, canonicalUri] = canonicalRequest.split('\n');
    expect(canonicalUri).toBe(
      '/s3/demo-bucket/archive/Project%20Files/Season%201/%5BClip%5D%20%E6%98%9F%E7%81%AB%20Demo%20A.mp4',
    );
  });

  it('canonicalizes mojibake-like segments and preserves plus signs in path', () => {
    const req = {
      method: 'GET',
      originalUrl:
        '/s3/demo-bucket/gallery/%E8%A6%96%E8%A6%BA%20Test/%C2%BCsample%2B%2B%20%C2%A7-%C2%A7x/frame-3.gif',
      headers: {
        host: 'localhost:3001',
        'x-amz-content-sha256': 'UNSIGNED-PAYLOAD',
        'x-amz-date': '20260501T010203Z',
      },
    };

    const canonicalRequest = (service as any).buildCanonicalRequest(req, [
      'host',
      'x-amz-content-sha256',
      'x-amz-date',
    ]);

    const [, canonicalUri] = canonicalRequest.split('\n');
    expect(canonicalUri).toBe(
      '/s3/demo-bucket/gallery/%E8%A6%96%E8%A6%BA%20Test/%C2%BCsample%2B%2B%20%C2%A7-%C2%A7x/frame-3.gif',
    );
  });

  it('sorts duplicate query params by encoded key then encoded value', () => {
    const canonicalQueryString = (service as any).buildCanonicalQueryString(
      'prefix=z&prefix=a&list-type=2&delimiter=%2F&max-keys=1000',
    );

    expect(canonicalQueryString).toBe(
      'delimiter=%2F&list-type=2&max-keys=1000&prefix=a&prefix=z',
    );
  });

  it('preserves literal plus signs in query values', () => {
    const canonicalQueryString = (service as any).buildCanonicalQueryString(
      'prefix=%2B%2B_mix.mp4&marker=a+b',
    );

    expect(canonicalQueryString).toBe('marker=a%2Bb&prefix=%2B%2B_mix.mp4');
  });

  it('excludes X-Amz-Signature from presigned canonical query string', () => {
    const req = {
      method: 'GET',
      originalUrl:
        '/s3/s3/backup/file.txt?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAEXAMPLE%2F20260501%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=20260501T010203Z&X-Amz-Expires=300&X-Amz-Signature=deadbeef&X-Amz-SignedHeaders=host',
      headers: {
        host: 'localhost:3001',
      },
    };

    const canonicalRequest = (service as any).buildCanonicalRequestPresigned(
      req,
      ['host'],
    );

    const lines = canonicalRequest.split('\n');
    expect(lines[2]).toBe(
      'X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAEXAMPLE%2F20260501%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=20260501T010203Z&X-Amz-Expires=300&X-Amz-SignedHeaders=host',
    );
  });

  it('normalizes signed header whitespace like SigV4 expects', () => {
    const normalized = (service as any).normalizeHeaderValue('  a   b\t c  ');
    expect(normalized).toBe('a b c');
  });

  it.each([
    ['identity', 'br, gzip'],
    ['gzip', 'gzip, br'],
  ])(
    'restores rclone signed accept-encoding %s after Cloudflare rewrites it to %s',
    async (signedValue, rewrittenValue) => {
      const secretAccessKey = 'test-secret-access-key';
      const accessKeyId = 'AKIATESTCLOUDFLARE01';
      const dateTime = new Date().toISOString().replace(/[-:]|\.\d{3}/g, '');
      const date = dateTime.slice(0, 8);
      const credentialScope = `${date}/us-east-1/s3/aws4_request`;
      const signedHeaders = [
        'accept-encoding',
        'host',
        'x-amz-content-sha256',
        'x-amz-date',
      ];
      const req: any = {
        method: 'GET',
        originalUrl: '/?x-id=ListBuckets',
        headers: {
          'accept-encoding': signedValue,
          host: 's3.example.com',
          'x-amz-content-sha256':
            'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
          'x-amz-date': dateTime,
        },
      };
      const canonicalRequest = (service as any).buildCanonicalRequest(
        req,
        signedHeaders,
      );
      const canonicalRequestHash = crypto
        .createHash('sha256')
        .update(canonicalRequest)
        .digest('hex');
      const stringToSign = [
        'AWS4-HMAC-SHA256',
        dateTime,
        credentialScope,
        canonicalRequestHash,
      ].join('\n');
      const signingKey = (service as any).deriveSigningKey(
        secretAccessKey,
        date,
        'us-east-1',
        's3',
      );
      const signature = crypto
        .createHmac('sha256', signingKey)
        .update(stringToSign)
        .digest('hex');

      req.headers['accept-encoding'] = rewrittenValue;
      req.headers['authorization'] =
        `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${credentialScope}, ` +
        `SignedHeaders=${signedHeaders.join(';')}, Signature=${signature}`;

      const prisma = {
        s3Credential: {
          findUnique: jest.fn().mockResolvedValue({
            accessKeyId,
            secretAccessKey,
            isActive: true,
            userId: 'user-1',
            user: {},
          }),
        },
      };
      service = new S3AuthService(prisma as never);

      await expect(service.verifySignature(req)).resolves.toBe('user-1');
    },
  );
});
