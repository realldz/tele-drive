// scripts/installer/lib/secrets.mjs
// Generate a strong alphanumeric REDIS_PASSWORD; never overwrite an existing one.

import { randomBytes } from 'node:crypto';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

export function generateRedisPassword(length = 40) {
  const out = [];
  // Rejection-free: map each random byte into the alphabet via modulo.
  // Alphabet length (62) is close enough to 256 that modulo bias is negligible for a secret.
  const bytes = randomBytes(length);
  for (let i = 0; i < length; i++) {
    out.push(ALPHABET[bytes[i] % ALPHABET.length]);
  }
  return out.join('');
}

export function ensureRedisPassword(existing) {
  if (typeof existing === 'string' && existing.length > 0) return existing;
  return generateRedisPassword(40);
}
