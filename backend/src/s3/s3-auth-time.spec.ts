import { S3AuthService } from './s3-auth.service';

describe('S3 authentication timestamp validation', () => {
  const lookup = jest.fn().mockResolvedValue(null);
  const service = new S3AuthService({
    s3Credential: { findUnique: lookup },
  } as never);
  beforeEach(() => {
    lookup.mockClear();
    jest.useFakeTimers().setSystemTime(Date.parse('2026-10-31T00:00:00Z'));
  });
  afterEach(() => jest.useRealTimers());
  const header =
    'AWS4-HMAC-SHA256 Credential=test/20261031/us-east-1/s3/aws4_request, SignedHeaders=host;x-amz-date, Signature=' +
    'a'.repeat(64);
  it.each([
    '',
    'bad',
    '20260230T000000Z',
    '20261031X000000Z',
    '20261031T990000Z',
    '20261030T000000Z',
  ])(
    'rejects malformed/stale header date %s before credential lookup',
    async (date) => {
      expect(
        await service.verifySignature({
          method: 'GET',
          url: '/',
          headers: {
            authorization: header,
            'x-amz-date': date,
            host: 's3.example.com',
          },
        }),
      ).toBeNull();
      expect(lookup).not.toHaveBeenCalled();
    },
  );
  it('allows a current valid header date to reach credential verification', async () => {
    await service.verifySignature({
      method: 'GET',
      url: '/',
      headers: {
        authorization: header,
        'x-amz-date': '20261031T000000Z',
        host: 's3.example.com',
      },
    });
    expect(lookup).toHaveBeenCalled();
  });
  it.each([
    ['20260230T000000Z', '300'],
    ['20261031T010000Z', '300'],
    ['20261030T000000Z', '300'],
    ['20261031T000000Z', '300oops'],
  ])(
    'rejects invalid presigned date/expiration %s %s',
    async (date, expires) => {
      const query = new URLSearchParams({
        'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
        'X-Amz-Credential': 'test/20261031/us-east-1/s3/aws4_request',
        'X-Amz-Date': date,
        'X-Amz-Expires': expires,
        'X-Amz-SignedHeaders': 'host',
        'X-Amz-Signature': 'a'.repeat(64),
      });
      await service.verifySignature({
        method: 'GET',
        url: '/?' + query.toString(),
        headers: { host: 's3.example.com' },
      });
      expect(lookup).not.toHaveBeenCalled();
    },
  );
});
