import { S3_DOMAIN_PLACEHOLDER, getPublicS3Domain } from './client-config.util';

describe('getPublicS3Domain', () => {
  const prev = process.env.S3_DOMAIN;

  afterEach(() => {
    if (prev === undefined) delete process.env.S3_DOMAIN;
    else process.env.S3_DOMAIN = prev;
  });

  it('returns null when env unset or blank', () => {
    delete process.env.S3_DOMAIN;
    expect(getPublicS3Domain()).toBeNull();
    process.env.S3_DOMAIN = '';
    expect(getPublicS3Domain()).toBeNull();
    process.env.S3_DOMAIN = '   ';
    expect(getPublicS3Domain()).toBeNull();
  });

  it('treats the compose/Go placeholder host as unconfigured', () => {
    process.env.S3_DOMAIN = S3_DOMAIN_PLACEHOLDER;
    expect(getPublicS3Domain()).toBeNull();
    process.env.S3_DOMAIN = 'S3.Example.com';
    expect(getPublicS3Domain()).toBeNull();
    process.env.S3_DOMAIN = 'https://s3.example.com/';
    expect(getPublicS3Domain()).toBeNull();
  });

  it('returns a configured host unchanged (trailing slashes aside)', () => {
    process.env.S3_DOMAIN = 's3.mydomain.com';
    expect(getPublicS3Domain()).toBe('s3.mydomain.com');
    process.env.S3_DOMAIN = ' https://s3.mydomain.com/ ';
    expect(getPublicS3Domain()).toBe('https://s3.mydomain.com');
  });
});
