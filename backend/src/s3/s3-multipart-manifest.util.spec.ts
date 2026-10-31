import {
  parseMultipartManifest,
  validateMultipartManifest,
} from './s3-multipart-manifest.util';
const etag = 'a'.repeat(32);
const part = (n: number) =>
  `<Part><PartNumber>${n}</PartNumber><ETag>"${etag}"</ETag></Part>`;
const body = (parts: string) =>
  `<CompleteMultipartUpload>${parts}</CompleteMultipartUpload>`;
describe('multipart manifest safety', () => {
  it('accepts ordered uploaded parts', () => {
    const parts = parseMultipartManifest(body(part(1) + part(2)));
    expect(() =>
      validateMultipartManifest(parts, [
        { chunkIndex: 0, etag },
        { chunkIndex: 1, etag },
      ]),
    ).not.toThrow();
  });
  it.each(['', '<PartNumber>1</PartNumber>', '<Part/>'])(
    'rejects malformed completion %s',
    (value) => {
      expect(() => parseMultipartManifest(body(value))).toThrow('MalformedXML');
    },
  );
  it('rejects reordered and duplicate parts', () => {
    expect(() => parseMultipartManifest(body(part(2) + part(1)))).toThrow(
      'InvalidPartOrder',
    );
    expect(() => parseMultipartManifest(body(part(1) + part(1)))).toThrow(
      'InvalidPartOrder',
    );
  });
  it('rejects a mismatched ETag', () => {
    expect(() =>
      validateMultipartManifest(parseMultipartManifest(body(part(1))), [
        { chunkIndex: 0, etag: 'b'.repeat(32) },
      ]),
    ).toThrow('InvalidPart');
  });
  it('never silently includes an undeclared stored part', () => {
    expect(() =>
      validateMultipartManifest(parseMultipartManifest(body(part(1))), [
        { chunkIndex: 0, etag },
        { chunkIndex: 1, etag },
      ]),
    ).toThrow('NotImplemented');
  });
});

it('accepts SDK ETag-first completion elements and escaped quotes', () => {
  expect(
    parseMultipartManifest(
      `<CompleteMultipartUpload xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Part><ETag>&quot;${etag}&quot;</ETag><PartNumber>1</PartNumber></Part></CompleteMultipartUpload>`,
    ),
  ).toEqual([{ partNumber: 1, etag }]);
});

it.each([
  'ChecksumCRC32',
  'ChecksumCRC32C',
  'ChecksumCRC64NVME',
  'ChecksumSHA1',
  'ChecksumSHA256',
])('accepts the standard per-part %s field emitted by SDKs', (tag) => {
  expect(
    parseMultipartManifest(
      body(
        `<Part><ETag>"${etag}"</ETag><${tag}>YWJjZA==</${tag}><PartNumber>1</PartNumber></Part>`,
      ),
    ),
  ).toEqual([{ partNumber: 1, etag }]);
});

it('rejects unknown checksum fields instead of silently dropping them', () => {
  expect(() =>
    parseMultipartManifest(
      body(
        `<Part><ETag>"${etag}"</ETag><ChecksumFuture>YWJjZA==</ChecksumFuture><PartNumber>1</PartNumber></Part>`,
      ),
    ),
  ).toThrow('MalformedXML');
});

it.each(['&#34;', '&#x22;'])('accepts XML numeric quote entity %s', (quote) => {
  expect(
    parseMultipartManifest(
      body(
        `<Part><ETag>${quote}${etag}${quote}</ETag><PartNumber>1</PartNumber></Part>`,
      ),
    ),
  ).toEqual([{ partNumber: 1, etag }]);
});
