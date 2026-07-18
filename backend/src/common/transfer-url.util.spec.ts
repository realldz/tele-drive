import { buildTransferUrl } from './transfer-url.util';

describe('buildTransferUrl', () => {
  const prev = process.env.PUBLIC_TRANSFER_URL;

  afterEach(() => {
    if (prev === undefined) delete process.env.PUBLIC_TRANSFER_URL;
    else process.env.PUBLIC_TRANSFER_URL = prev;
  });

  it('returns path unchanged when env unset (relative passthrough)', () => {
    delete process.env.PUBLIC_TRANSFER_URL;
    expect(buildTransferUrl('/files/d/tok')).toBe('/files/d/tok');
    expect(buildTransferUrl('/transfer/download-zip/1/file/0')).toBe(
      '/transfer/download-zip/1/file/0',
    );
  });

  it('returns path unchanged when env empty', () => {
    process.env.PUBLIC_TRANSFER_URL = '';
    expect(buildTransferUrl('/files/d/tok')).toBe('/files/d/tok');
  });

  it('prefixes origin when env set', () => {
    process.env.PUBLIC_TRANSFER_URL = 'https://transfer.example.com';
    expect(buildTransferUrl('/files/d/tok')).toBe(
      'https://transfer.example.com/files/d/tok',
    );
  });

  it('normalizes trailing slash(es)', () => {
    process.env.PUBLIC_TRANSFER_URL = 'https://transfer.example.com///';
    expect(buildTransferUrl('/files/d/tok')).toBe(
      'https://transfer.example.com/files/d/tok',
    );
  });
});
