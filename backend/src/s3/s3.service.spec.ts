import { BadRequestException } from '@nestjs/common';
import { S3Service } from './s3.service';

describe('S3Service', () => {
  let service: S3Service;

  beforeEach(() => {
    // S3Service only needs prisma in constructor — mock it minimally
    service = new S3Service({ folder: {}, fileRecord: {} } as any);
  });

  describe('parseDeleteObjectsXml', () => {
    it('should parse keys from valid XML', () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Delete>
  <Object><Key>photos/img1.jpg</Key></Object>
  <Object><Key>photos/img2.jpg</Key></Object>
</Delete>`;
      const result = service.parseDeleteObjectsXml(xml);
      expect(result.quiet).toBe(false);
      expect(result.keys).toEqual(['photos/img1.jpg', 'photos/img2.jpg']);
    });

    it('should parse Quiet=true', () => {
      const xml = `<Delete><Quiet>true</Quiet><Object><Key>a.txt</Key></Object></Delete>`;
      const result = service.parseDeleteObjectsXml(xml);
      expect(result.quiet).toBe(true);
      expect(result.keys).toEqual(['a.txt']);
    });

    it('should default Quiet to false when omitted', () => {
      const xml = `<Delete><Object><Key>a.txt</Key></Object></Delete>`;
      const result = service.parseDeleteObjectsXml(xml);
      expect(result.quiet).toBe(false);
    });

    it('should decode XML entities in keys', () => {
      const xml = `<Delete><Object><Key>a&amp;b.txt</Key></Object></Delete>`;
      const result = service.parseDeleteObjectsXml(xml);
      expect(result.keys).toEqual(['a&b.txt']);
    });

    it('should throw BadRequestException on more than 1000 keys', () => {
      const objects = Array.from({ length: 1001 }, (_, i) =>
        `<Object><Key>file${i}.txt</Key></Object>`
      ).join('');
      const xml = `<Delete>${objects}</Delete>`;
      expect(() => service.parseDeleteObjectsXml(xml)).toThrow(BadRequestException);
      expect(() => service.parseDeleteObjectsXml(xml)).toThrow('MalformedXML');
    });

    it('should throw on empty key list', () => {
      const xml = `<Delete></Delete>`;
      expect(() => service.parseDeleteObjectsXml(xml)).toThrow('MalformedXML');
    });
  });

  describe('buildDeleteResultXml', () => {
    it('should include both Deleted and Error entries in verbose mode', () => {
      const xml = service.buildDeleteResultXml(
        [{ key: 'ok.txt' }],
        [{ key: 'missing.txt', code: 'NoSuchKey', message: 'The specified key does not exist.' }],
        false,
      );

      expect(xml).toContain('<Deleted>');
      expect(xml).toContain('<Key>ok.txt</Key>');
      expect(xml).toContain('<Error>');
      expect(xml).toContain('<Key>missing.txt</Key>');
      expect(xml).toContain('<Code>NoSuchKey</Code>');
      expect(xml).toContain('<Message>The specified key does not exist.</Message>');
    });

    it('should include only Error entries in quiet mode', () => {
      const xml = service.buildDeleteResultXml(
        [{ key: 'ok.txt' }],
        [{ key: 'missing.txt', code: 'NoSuchKey', message: 'The specified key does not exist.' }],
        true,
      );

      expect(xml).not.toContain('<Deleted>');
      expect(xml).toContain('<Error>');
      expect(xml).toContain('<Key>missing.txt</Key>');
    });

    it('should return empty DeleteResult body for all-success quiet mode', () => {
      const xml = service.buildDeleteResultXml([{ key: 'ok.txt' }], [], true);

      expect(xml).toContain('<DeleteResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"></DeleteResult>');
      expect(xml).not.toContain('<Deleted>');
      expect(xml).not.toContain('<Error>');
    });

    it('should escape XML entities in output', () => {
      const xml = service.buildDeleteResultXml(
        [{ key: `a&b<"'` }],
        [{ key: `x&y`, code: `Bad<&>"'`, message: `Oops<&>"'` }],
        false,
      );

      expect(xml).toContain('<Key>a&amp;b&lt;&quot;&apos;</Key>');
      expect(xml).toContain('<Key>x&amp;y</Key>');
      expect(xml).toContain('<Code>Bad&lt;&amp;&gt;&quot;&apos;</Code>');
      expect(xml).toContain('<Message>Oops&lt;&amp;&gt;&quot;&apos;</Message>');
    });
  });
});
