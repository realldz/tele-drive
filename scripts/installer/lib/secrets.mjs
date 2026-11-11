// scripts/installer/lib/secrets.mjs
// Generate a strong alphanumeric REDIS_PASSWORD; never overwrite an existing one.

import { randomBytes } from 'node:crypto';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const MAX_UNBIASED_BYTE = 256 - (256 % ALPHABET.length);

export function generateRedisPassword(length = 40) {
  const out = [];
  let bytes = randomBytes(length);

  // Rejection sampling keeps every alphabet character equally likely. Bytes
  // from 248 through 255 are discarded because 256 is not divisible by 62.
  while (out.length < length) {
    for (const byte of bytes) {
      if (byte >= MAX_UNBIASED_BYTE) continue;
      out.push(ALPHABET[byte % ALPHABET.length]);
      if (out.length === length) break;
    }
    if (out.length < length) bytes = randomBytes(length - out.length);
  }
  return out.join('');
}

export function ensureRedisPassword(existing) {
  if (typeof existing === 'string' && existing.length > 0) return existing;
  return generateRedisPassword(40);
}

// Same alphabet/size for the Postgres password: alphanumeric needs no
// percent-encoding, so the value survives the DATABASE_URL round-trip from the
// db host to .env.core untouched. Never overwrites an existing value.
export function ensurePostgresPassword(existing) {
  if (typeof existing === 'string' && existing.length > 0) return existing;
  return generateRedisPassword(40);
}
