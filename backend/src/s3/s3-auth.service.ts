import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import * as crypto from 'crypto';

/**
 * S3 Authentication Service — AWS Signature Version 4 verification.
 *
 * AWS Sig V4 Authorization header format:
 *   AWS4-HMAC-SHA256
 *   Credential=<AccessKeyId>/<Date>/<Region>/<Service>/aws4_request,
 *   SignedHeaders=<headers>,
 *   Signature=<hex>
 */
@Injectable()
export class S3AuthService {
  private readonly logger = new Logger(S3AuthService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Verify AWS Signature V4 and return userId if valid.
   * Supports both Authorization header and presigned URL (query string) auth.
   * Returns null if verification fails.
   */
  async verifySignature(req: any): Promise<string | null> {
    try {
      const authHeader: string | undefined = req.headers['authorization'];

      // Presigned URL fallback — check query string params
      if (!authHeader || !authHeader.startsWith('AWS4-HMAC-SHA256 ')) {
        return this.verifyPresignedUrl(req);
      }

      // Parse Authorization header
      const parsed = this.parseAuthHeader(authHeader);
      if (!parsed) {
        this.logger.debug('Failed to parse Authorization header');
        return null;
      }

      const { accessKeyId, credentialScope, signedHeaders, signature, date, region, service } = parsed;

      // Date skew check — reject requests more than 15 minutes old
      const dateTime = req.headers['x-amz-date'] as string || '';
      if (dateTime.length === 16) {
        const reqTime = new Date(
          `${dateTime.slice(0,4)}-${dateTime.slice(4,6)}-${dateTime.slice(6,8)}T${dateTime.slice(9,11)}:${dateTime.slice(11,13)}:${dateTime.slice(13,15)}Z`,
        );
        const skewMs = Math.abs(Date.now() - reqTime.getTime());
        if (skewMs > 15 * 60 * 1000) {
          this.logger.warn(`S3 auth denied: request timestamp too old (skew=${Math.round(skewMs/1000)}s)`);
          return null;
        }
      }

      // Look up S3Credential by accessKeyId
      const credential = await this.prisma.s3Credential.findUnique({
        where: { accessKeyId },
        include: { user: true },
      });

      if (!credential || !credential.isActive) {
        this.logger.warn(`S3 auth failed: AccessKeyId not found or inactive: ${accessKeyId}`);
        return null;
      }

      // Decrypt the stored secretAccessKey
      const secretAccessKey = this.decryptSecret(credential.secretAccessKey);

      // Build canonical request
      const canonicalRequest = this.buildCanonicalRequest(req, signedHeaders);
      const canonicalRequestHash = crypto
        .createHash('sha256')
        .update(canonicalRequest)
        .digest('hex');

      // Build string to sign
      const stringToSign = [
        'AWS4-HMAC-SHA256',
        dateTime,
        credentialScope,
        canonicalRequestHash,
      ].join('\n');

      // Derive signing key
      const signingKey = this.deriveSigningKey(secretAccessKey, date, region, service);

      // Compute expected signature
      const expectedSignature = crypto
        .createHmac('sha256', signingKey)
        .update(stringToSign)
        .digest('hex');

      if (expectedSignature !== signature) {
        this.logger.warn(`S3 auth failed: signature mismatch for AccessKeyId: ${accessKeyId}`);
        return null;
      }

      this.logger.debug(`S3 auth success: userId=${credential.userId}, accessKeyId=${accessKeyId}`);
      return credential.userId;
    } catch (err: any) {
      this.logger.error(`S3 auth error: ${err.message}`, err.stack);
      return null;
    }
  }

  /**
   * Verify presigned URL (query-string-based AWS Signature V4).
   *
   * Query params used:
   *   X-Amz-Algorithm=AWS4-HMAC-SHA256
   *   X-Amz-Credential=<AccessKeyId>/<Date>/<Region>/<Service>/aws4_request
   *   X-Amz-Date=<YYYYMMDDTHHMMSSZ>
   *   X-Amz-Expires=<seconds>
   *   X-Amz-SignedHeaders=<headers>
   *   X-Amz-Signature=<hex>
   */
  private async verifyPresignedUrl(req: any): Promise<string | null> {
    try {
      const url = new URL(req.url, `http://${req.headers['host'] || 'localhost'}`);
      const params = url.searchParams;

      const algorithm = params.get('X-Amz-Algorithm');
      if (algorithm !== 'AWS4-HMAC-SHA256') {
        this.logger.debug('Missing or invalid Authorization header / presigned params');
        return null;
      }

      const credentialStr = params.get('X-Amz-Credential');
      const dateTime = params.get('X-Amz-Date');
      const expiresStr = params.get('X-Amz-Expires');
      const signedHeadersStr = params.get('X-Amz-SignedHeaders');
      const signature = params.get('X-Amz-Signature');

      if (!credentialStr || !dateTime || !expiresStr || !signedHeadersStr || !signature) {
        this.logger.debug('Presigned URL missing required query params');
        return null;
      }

      // Parse credential: <AccessKeyId>/<Date>/<Region>/<Service>/aws4_request
      const credParts = credentialStr.split('/');
      if (credParts.length < 5) {
        this.logger.debug('Presigned URL: invalid credential format');
        return null;
      }
      const [accessKeyId, date, region, service] = credParts;
      const credentialScope = credParts.slice(1).join('/');

      // Expiration check
      const expires = parseInt(expiresStr, 10);
      if (isNaN(expires) || expires < 1 || expires > 604800) {
        this.logger.warn(`Presigned URL: invalid Expires value: ${expiresStr}`);
        return null;
      }

      if (dateTime.length !== 16) {
        this.logger.debug('Presigned URL: invalid X-Amz-Date format');
        return null;
      }
      const reqTime = new Date(
        `${dateTime.slice(0,4)}-${dateTime.slice(4,6)}-${dateTime.slice(6,8)}T${dateTime.slice(9,11)}:${dateTime.slice(11,13)}:${dateTime.slice(13,15)}Z`,
      );
      const expirationTime = reqTime.getTime() + expires * 1000;
      if (Date.now() > expirationTime) {
        this.logger.warn('Presigned URL: URL has expired');
        return null;
      }

      // Look up credential
      const credential = await this.prisma.s3Credential.findUnique({
        where: { accessKeyId },
        include: { user: true },
      });

      if (!credential || !credential.isActive) {
        this.logger.warn(`Presigned URL auth failed: AccessKeyId not found or inactive: ${accessKeyId}`);
        return null;
      }

      const secretAccessKey = this.decryptSecret(credential.secretAccessKey);
      const signedHeaders = signedHeadersStr.split(';');

      // Build canonical request — for presigned URLs, exclude X-Amz-Signature
      // from canonical query string and use UNSIGNED-PAYLOAD as payload hash
      const canonicalRequest = this.buildCanonicalRequestPresigned(req, signedHeaders);
      const canonicalRequestHash = crypto
        .createHash('sha256')
        .update(canonicalRequest)
        .digest('hex');

      // Build string to sign
      const stringToSign = [
        'AWS4-HMAC-SHA256',
        dateTime,
        credentialScope,
        canonicalRequestHash,
      ].join('\n');

      // Derive signing key
      const signingKey = this.deriveSigningKey(secretAccessKey, date, region, service);

      // Compute expected signature
      const expectedSignature = crypto
        .createHmac('sha256', signingKey)
        .update(stringToSign)
        .digest('hex');

      if (expectedSignature !== signature) {
        this.logger.warn(`Presigned URL auth failed: signature mismatch for AccessKeyId: ${accessKeyId}`);
        return null;
      }

      this.logger.debug(`Presigned URL auth success: userId=${credential.userId}, accessKeyId=${accessKeyId}`);
      return credential.userId;
    } catch (err: any) {
      this.logger.error(`Presigned URL auth error: ${err.message}`, err.stack);
      return null;
    }
  }

  /**
   * Parse AWS4-HMAC-SHA256 Authorization header.
   */
  private parseAuthHeader(authHeader: string): {
    accessKeyId: string;
    credentialScope: string;
    signedHeaders: string[];
    signature: string;
    date: string;
    region: string;
    service: string;
  } | null {
    try {
      // Remove algorithm prefix
      const content = authHeader.replace('AWS4-HMAC-SHA256 ', '');
      const parts: Record<string, string> = {};

      for (const part of content.split(', ')) {
        const eqIdx = part.indexOf('=');
        if (eqIdx === -1) continue;
        const key = part.substring(0, eqIdx).trim();
        const value = part.substring(eqIdx + 1).trim();
        parts[key] = value;
      }

      const credential = parts['Credential'];
      const signedHeadersStr = parts['SignedHeaders'];
      const signature = parts['Signature'];

      if (!credential || !signedHeadersStr || !signature) return null;

      // Credential = <AccessKeyId>/<Date>/<Region>/<Service>/aws4_request
      const credParts = credential.split('/');
      if (credParts.length < 5) return null;

      const [accessKeyId, date, region, service] = credParts;
      const credentialScope = credParts.slice(1).join('/');

      return {
        accessKeyId,
        credentialScope,
        signedHeaders: signedHeadersStr.split(';'),
        signature,
        date,
        region,
        service,
      };
    } catch {
      return null;
    }
  }

  /**
   * Build canonical request string for Sig V4.
   */
  private buildCanonicalRequest(req: any, signedHeaders: string[]): string {
    const method = req.method.toUpperCase();

    // Canonical URI — the path (without query string)
    const url = new URL(req.url, `http://${req.headers['host'] || 'localhost'}`);
    const canonicalUri = url.pathname || '/';

    // Canonical Query String — sorted by key
    const queryParams: [string, string][] = [];
    url.searchParams.forEach((value, key) => {
      queryParams.push([key, value]);
    });
    queryParams.sort(([a], [b]) => a.localeCompare(b));
    const canonicalQueryString = queryParams
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join('&');

    // Canonical Headers — only signed headers, sorted
    const canonicalHeaderLines = signedHeaders
      .map((h) => {
        const val = req.headers[h.toLowerCase()];
        return `${h.toLowerCase()}:${Array.isArray(val) ? val.join(',') : (val || '')}`;
      })
      .join('\n');

    const signedHeadersStr = signedHeaders.join(';');

    // Payload hash — use x-amz-content-sha256 if present, else unsigned payload
    const payloadHash =
      (req.headers['x-amz-content-sha256'] as string) || 'UNSIGNED-PAYLOAD';

    return [
      method,
      canonicalUri,
      canonicalQueryString,
      canonicalHeaderLines + '\n',
      signedHeadersStr,
      payloadHash,
    ].join('\n');
  }

  /**
   * Build canonical request for presigned URLs.
   * Differs from header-based auth:
   *   - X-Amz-Signature is excluded from canonical query string
   *   - Payload hash is always UNSIGNED-PAYLOAD
   */
  private buildCanonicalRequestPresigned(req: any, signedHeaders: string[]): string {
    const method = req.method.toUpperCase();

    const url = new URL(req.url, `http://${req.headers['host'] || 'localhost'}`);
    const canonicalUri = url.pathname || '/';

    // Canonical Query String — sorted by key, excluding X-Amz-Signature
    const queryParams: [string, string][] = [];
    url.searchParams.forEach((value, key) => {
      if (key !== 'X-Amz-Signature') {
        queryParams.push([key, value]);
      }
    });
    queryParams.sort(([a], [b]) => a.localeCompare(b));
    const canonicalQueryString = queryParams
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join('&');

    // Canonical Headers
    const canonicalHeaderLines = signedHeaders
      .map((h) => {
        const val = req.headers[h.toLowerCase()];
        return `${h.toLowerCase()}:${Array.isArray(val) ? val.join(',') : (val || '')}`;
      })
      .join('\n');

    const signedHeadersStr = signedHeaders.join(';');

    return [
      method,
      canonicalUri,
      canonicalQueryString,
      canonicalHeaderLines + '\n',
      signedHeadersStr,
      'UNSIGNED-PAYLOAD',
    ].join('\n');
  }

  /**
   * Derive HMAC-SHA256 signing key from secret + date + region + service.
   */
  private deriveSigningKey(
    secretAccessKey: string,
    date: string,
    region: string,
    service: string,
  ): Buffer {
    const kDate = crypto
      .createHmac('sha256', `AWS4${secretAccessKey}`)
      .update(date)
      .digest();
    const kRegion = crypto.createHmac('sha256', kDate).update(region).digest();
    const kService = crypto.createHmac('sha256', kRegion).update(service).digest();
    const kSigning = crypto.createHmac('sha256', kService).update('aws4_request').digest();
    return kSigning;
  }

  /**
   * Generate a new AccessKeyId (20 chars, AKIA prefix).
   */
  generateAccessKeyId(): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    const suffix = Array.from(
      { length: 16 },
      () => chars[crypto.randomInt(chars.length)],
    ).join('');
    return `AKIA${suffix}`;
  }

  /**
   * Generate a new SecretAccessKey (40 chars, random base64url).
   */
  generateSecretAccessKey(): string {
    return crypto.randomBytes(30).toString('base64url').substring(0, 40);
  }

  /**
   * Encrypt secret before storing.
   * Uses a simple AES-256-CBC with MASTER_SECRET from env.
   */
  encryptSecret(secret: string): string {
    const masterKey = this.getMasterKey();
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-cbc', masterKey, iv);
    const encrypted = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
    return `${iv.toString('hex')}:${encrypted.toString('hex')}`;
  }

  /**
   * Decrypt stored secret.
   */
  private decryptSecret(encryptedSecret: string): string {
    // Handle legacy plain secrets (not encrypted)
    if (!encryptedSecret.includes(':')) return encryptedSecret;

    const masterKey = this.getMasterKey();
    const [ivHex, encryptedHex] = encryptedSecret.split(':');
    const iv = Buffer.from(ivHex, 'hex');
    const encrypted = Buffer.from(encryptedHex, 'hex');
    const decipher = crypto.createDecipheriv('aes-256-cbc', masterKey, iv);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
  }

  private getMasterKey(): Buffer {
    const masterSecret = process.env.MASTER_SECRET || 'default-master-secret-change-me!';
    // Derive a 32-byte key from MASTER_SECRET
    return crypto.createHash('sha256').update(masterSecret).digest();
  }
}
