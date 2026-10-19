import { ClientConfigController } from './client-config.controller';

describe('ClientConfigController', () => {
  const prevTransfer = process.env.PUBLIC_TRANSFER_URL;
  const prevS3 = process.env.S3_DOMAIN;

  afterEach(() => {
    if (prevTransfer === undefined) delete process.env.PUBLIC_TRANSFER_URL;
    else process.env.PUBLIC_TRANSFER_URL = prevTransfer;
    if (prevS3 === undefined) delete process.env.S3_DOMAIN;
    else process.env.S3_DOMAIN = prevS3;
  });

  it('returns nulls when neither domain is configured', () => {
    delete process.env.PUBLIC_TRANSFER_URL;
    delete process.env.S3_DOMAIN;

    expect(new ClientConfigController().getClientConfig()).toEqual({
      transferUrl: null,
      s3Domain: null,
    });
  });

  it('returns the normalized transfer origin and the configured S3 host', () => {
    process.env.PUBLIC_TRANSFER_URL = 'https://transfer.example.com///';
    process.env.S3_DOMAIN = 's3.mydomain.com';

    expect(new ClientConfigController().getClientConfig()).toEqual({
      transferUrl: 'https://transfer.example.com',
      s3Domain: 's3.mydomain.com',
    });
  });

  it('never advertises the S3 placeholder host', () => {
    process.env.PUBLIC_TRANSFER_URL = '///';
    process.env.S3_DOMAIN = 's3.example.com';

    expect(new ClientConfigController().getClientConfig()).toEqual({
      transferUrl: null,
      s3Domain: null,
    });
  });
});
