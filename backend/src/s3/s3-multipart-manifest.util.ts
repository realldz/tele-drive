import { BadRequestException, NotImplementedException } from '@nestjs/common';
export interface CompletedS3Part {
  partNumber: number;
  etag: string;
}

/** Accept the standard completion envelope, rejecting unparsed XML. */
export function parseMultipartManifest(body: string): CompletedS3Part[] {
  const envelope = body
    .trim()
    .replace(/^<\?xml[^?]*\?>\s*/, '')
    .match(
      /^<CompleteMultipartUpload(?:\s+xmlns="[^"]*")?\s*>([\s\S]*)<\/CompleteMultipartUpload>$/,
    );
  if (!envelope) throw new BadRequestException('MalformedXML');
  const parts: CompletedS3Part[] = [];
  const remaining = envelope[1].replace(
    /<Part>([\s\S]*?)<\/Part>/g,
    (_match: string, content: string) => {
      const number = content.match(/<PartNumber>(\d+)<\/PartNumber>/);
      const etag = content.match(/<ETag>([^<]*)<\/ETag>/);
      // AWS CLI v2 sends a per-part checksum by default. We still validate the
      // stored plaintext MD5 via ETag below; accept and ignore the additional
      // standard checksum field so modern clients can complete the upload.
      const withoutChecksums = content.replace(
        /<(Checksum(?:CRC32C?|CRC64NVME|SHA1|SHA256))>[A-Za-z0-9+/]+={0,2}<\/\1>/g,
        '',
      );
      if (
        !number ||
        !etag ||
        withoutChecksums.replace(number[0], '').replace(etag[0], '').trim()
      )
        throw new BadRequestException('MalformedXML');
      parts.push({
        partNumber: Number(number[1]),
        etag: etag[1]
          .trim()
          .replace(/&(?:quot|#0*34|#x0*22);/gi, '"')
          .replace(/^"|"$/g, ''),
      });
      return '';
    },
  );
  if (remaining.trim() || !parts.length || parts.length > 10000)
    throw new BadRequestException('MalformedXML');
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (
      part.partNumber < 1 ||
      part.partNumber > 10000 ||
      !/^[a-fA-F0-9]{32}$/.test(part.etag)
    )
      throw new BadRequestException('InvalidPart');
    if (i && part.partNumber <= parts[i - 1].partNumber)
      throw new BadRequestException('InvalidPartOrder');
  }
  return parts;
}

/** Current storage uses consecutive chunk indices; never silently assemble other parts. */
export function validateMultipartManifest(
  parts: CompletedS3Part[],
  chunks: { chunkIndex: number; etag: string | null }[],
): void {
  for (const part of parts) {
    const stored = chunks.find(
      (chunk) => chunk.chunkIndex === part.partNumber - 1,
    );
    if (!stored || stored.etag?.replace(/^"|"$/g, '') !== part.etag)
      throw new BadRequestException('InvalidPart');
  }
  if (
    parts.length !== chunks.length ||
    parts.some((part, index) => part.partNumber !== index + 1)
  ) {
    throw new NotImplementedException(
      'NotImplemented: completion requires all consecutive uploaded parts',
    );
  }
}
