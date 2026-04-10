import { Injectable, Logger } from '@nestjs/common';
import * as crypto from 'crypto';
import { Transform, TransformCallback } from 'stream';

/**
 * Transform stream that handles AES-256-CTR decryption with an arbitrary random-access byte offset.
 * It computes the correct block index, fast-forwards the IV, and drops the leading bytes of the first block
 * to align perfectly with the requested offset.
 *
 * IMPORTANT: The input ciphertext is expected to start exactly at `byteOffset` (i.e. the upstream
 * Range response already skipped bytes before `byteOffset`).  When the offset is not block-aligned
 * we must feed `bytesToDrop` dummy ciphertext bytes into the decipher first so that the AES-CTR
 * keystream counter is properly aligned before the real ciphertext arrives.
 */
export class AesCtrOffsetStream extends Transform {
  private decipher: crypto.Decipher;
  private dropped = 0;
  private bytesToDrop: number;
  private paddingInjected = false;

  constructor(algo: string, key: Buffer, iv: Buffer, byteOffset: number) {
    super();
    this.bytesToDrop = byteOffset % 16;
    const blockIndex = Math.floor(byteOffset / 16);

    // Increment the 16-byte IV by blockIndex (Big-Endian integer addition)
    const newIv = Buffer.from(iv);
    // JS Number is exact up to 2^53, blockIndex easily fits for files up to TBs
    let carry = blockIndex;
    for (let i = 15; i >= 0 && carry > 0; i--) {
      const sum = newIv[i] + carry;
      newIv[i] = sum & 0xff;
      carry = Math.floor(sum / 256);
    }

    this.decipher = crypto.createDecipheriv(algo, key, newIv);

    this.decipher.on('data', (chunk: Buffer) => {
      if (this.dropped < this.bytesToDrop) {
        const toDrop = Math.min(this.bytesToDrop - this.dropped, chunk.length);
        this.dropped += toDrop;
        if (toDrop < chunk.length) {
          this.push(chunk.subarray(toDrop));
        }
      } else {
        this.push(chunk);
      }
    });

    this.decipher.on('end', () => this.push(null));
    this.decipher.on('error', (err) => this.emit('error', err));
  }

  _transform(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: TransformCallback,
  ) {
    // On the first chunk, inject `bytesToDrop` zero-padding bytes into the decipher
    // so the keystream advances past the partial block before real ciphertext arrives.
    // The decrypted output of these padding bytes will be dropped by the `data` handler above.
    if (!this.paddingInjected && this.bytesToDrop > 0) {
      this.paddingInjected = true;
      this.decipher.write(Buffer.alloc(this.bytesToDrop));
    }
    this.decipher.write(chunk);
    callback();
  }

  _flush(callback: TransformCallback) {
    this.decipher.end();
    // 'end' event will automatically be pushed via the on('end') listener above
    callback();
  }
}

export interface SignedTokenPayload {
  fid: string;
  exp: number;
  t: 'u' | 's' | 'sf';
  uid?: string;
}

export interface StreamCookiePayload {
  sub: string;
  exp: number;
}

@Injectable()
export class CryptoService {
  private readonly logger = new Logger(CryptoService.name);
  private MASTER_SECRET: string;
  private readonly ALGO = 'aes-256-ctr';

  constructor() {
    this.MASTER_SECRET =
      process.env.MASTER_SECRET || 'default_secret_key_32_bytes_long.';

    // Ensure MASTER_SECRET is exactly 32 bytes for aes-256
    if (Buffer.from(this.MASTER_SECRET).length !== 32) {
      if (process.env.NODE_ENV === 'production') {
        throw new Error(
          'MASTER_SECRET must be exactly 32 bytes long for aes-256-ctr',
        );
      }
      this.logger.warn(
        'MASTER_SECRET is not 32 bytes! Padding/truncating for development.',
      );
      this.MASTER_SECRET = this.MASTER_SECRET.padEnd(32, '0').slice(0, 32);
    }
  }

  /**
   * Generates a 32-byte Data Encryption Key (DEK) for a file
   */
  generateFileKey(): Buffer {
    return crypto.randomBytes(32);
  }

  /**
   * Generates a random 16-byte Initialization Vector (IV)
   */
  generateIv(): Buffer {
    return crypto.randomBytes(16);
  }

  /**
   * Encrypts the Data Encryption Key with the system's MASTER_SECRET
   * Returns "ivHex:encryptedDekHex" string format
   */
  encryptKey(dek: Buffer): string {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv(
      this.ALGO,
      Buffer.from(this.MASTER_SECRET),
      iv,
    );
    const encrypted = Buffer.concat([cipher.update(dek), cipher.final()]);
    return `${iv.toString('hex')}:${encrypted.toString('hex')}`;
  }

  /**
   * Decrypts the DEK using the system's MASTER_SECRET
   */
  decryptKey(encryptedDekHex: string): Buffer {
    const [ivHex, encryptedHex] = encryptedDekHex.split(':');
    const iv = Buffer.from(ivHex, 'hex');
    const encrypted = Buffer.from(encryptedHex, 'hex');
    const decipher = crypto.createDecipheriv(
      this.ALGO,
      Buffer.from(this.MASTER_SECRET),
      iv,
    );
    return Buffer.concat([decipher.update(encrypted), decipher.final()]);
  }

  /**
   * Creates a CipherStream to pipe upload data to Telegram
   */
  createEncryptStream(dek: Buffer, iv: Buffer): crypto.Cipher {
    return crypto.createCipheriv(this.ALGO, dek, iv);
  }

  /**
   * Creates a DecipherStream to decrypt downloaded data from Telegram
   */
  createDecryptStream(dek: Buffer, iv: Buffer): crypto.Decipher {
    return crypto.createDecipheriv(this.ALGO, dek, iv);
  }

  /**
   * Creates a DecipherStream suitable for random access streaming (Range Requests)
   */
  createOffsetDecryptStream(
    dek: Buffer,
    iv: Buffer,
    byteOffset: number,
  ): Transform {
    if (byteOffset === 0) {
      return this.createDecryptStream(dek, iv);
    }
    return new AesCtrOffsetStream(this.ALGO, dek, iv, byteOffset);
  }

  // ── Signed Download Token ────────────────────────────────────────────────

  private hmacSign(data: string): string {
    return crypto
      .createHmac('sha256', this.MASTER_SECRET)
      .update(data)
      .digest('hex');
  }

  /**
   * Tạo signed download token (base64url-encoded JSON)
   */
  createSignedToken(
    fileId: string,
    type: 'u' | 's' | 'sf',
    ttlSeconds: number,
    userId?: string,
  ): string {
    const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
    const sigStr = userId
      ? `${fileId}:${exp}:${type}:${userId}`
      : `${fileId}:${exp}:${type}`;
    const sig = this.hmacSign(sigStr);
    const payloadObj: any = { fid: fileId, exp, t: type, sig };
    if (userId) payloadObj.uid = userId;
    const payload = JSON.stringify(payloadObj);
    return Buffer.from(payload).toString('base64url');
  }

  /**
   * Verify + decode signed download token. Returns null nếu invalid hoặc expired.
   */
  verifySignedToken(token: string): SignedTokenPayload | null {
    try {
      const json = Buffer.from(token, 'base64url').toString('utf8');
      const { fid, exp, t, sig, uid } = JSON.parse(json);
      if (!fid || !exp || !t || !sig) return null;
      const sigStr = uid ? `${fid}:${exp}:${t}:${uid}` : `${fid}:${exp}:${t}`;
      const expectedSig = this.hmacSign(sigStr);
      if (
        !crypto.timingSafeEqual(
          Buffer.from(sig, 'hex'),
          Buffer.from(expectedSig, 'hex'),
        )
      )
        return null;
      if (Math.floor(Date.now() / 1000) > exp) return null;
      return { fid, exp, t, uid };
    } catch {
      return null;
    }
  }

  // ── Stream Cookie Token ──────────────────────────────────────────────────

  /**
   * Tạo stream cookie token — chứa subject (userId hoặc guest:ip), dùng chung cho mọi file.
   */
  createStreamCookieToken(subject: string, ttlSeconds: number): string {
    const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
    const sig = this.hmacSign(`stream:${subject}:${exp}`);
    const payload = JSON.stringify({ sub: subject, exp, sig });
    return Buffer.from(payload).toString('base64url');
  }

  /**
   * Verify + decode stream cookie token. Returns null nếu invalid hoặc expired.
   */
  verifyStreamCookieToken(token: string): StreamCookiePayload | null {
    try {
      const json = Buffer.from(token, 'base64url').toString('utf8');
      const { sub, exp, sig } = JSON.parse(json);
      if (!sub || !exp || !sig) return null;
      const expectedSig = this.hmacSign(`stream:${sub}:${exp}`);
      if (
        !crypto.timingSafeEqual(
          Buffer.from(sig, 'hex'),
          Buffer.from(expectedSig, 'hex'),
        )
      )
        return null;
      if (Math.floor(Date.now() / 1000) > exp) return null;
      return { sub, exp };
    } catch {
      return null;
    }
  }
}
