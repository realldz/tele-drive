import { resolveMimeType } from './resolve-mime-type';

describe('resolveMimeType', () => {
  it('trusts a specific client-provided MIME type', () => {
    expect(resolveMimeType('photo.jpg', 'image/jpeg')).toBe('image/jpeg');
  });

  it('resolves from extension when client type is empty', () => {
    expect(resolveMimeType('notes.md', '')).toBe('text/markdown');
  });

  it('resolves from extension when client type is missing', () => {
    expect(resolveMimeType('data.yaml')).toBe('text/yaml');
  });

  it('resolves from extension when client sends generic octet-stream', () => {
    expect(resolveMimeType('archive.zip', 'application/octet-stream')).toBe(
      'application/zip',
    );
  });

  it('resolves common types the browser often misses', () => {
    expect(resolveMimeType('book.epub')).toBe('application/epub+zip');
    expect(resolveMimeType('script.ts')).toBe('video/mp2t');
  });

  it('falls back to octet-stream for an unknown extension', () => {
    expect(resolveMimeType('mystery.zzz', '')).toBe('application/octet-stream');
  });

  it('falls back to octet-stream when there is no extension', () => {
    expect(resolveMimeType('README')).toBe('application/octet-stream');
  });

  it('trims surrounding whitespace on a specific client type', () => {
    expect(resolveMimeType('photo.jpg', '  image/png  ')).toBe('image/png');
  });
});
