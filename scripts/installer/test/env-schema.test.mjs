// scripts/installer/test/env-schema.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isExact32, isNumeric, isPositiveInt, isIpv4, isFilename, isHostname,
  fieldsFor, validateValues, isCdnMode, isCdnTtl, isCdnWindow, isPurgeProvider, isZoneId, isOriginUrl,
} from '../lib/env-schema.mjs';

test('isExact32 accepts exactly 32 chars, rejects otherwise', () => {
  assert.equal(isExact32('a'.repeat(32)), null);
  assert.notEqual(isExact32('a'.repeat(31)), null);
  assert.notEqual(isExact32('a'.repeat(33)), null);
});

test('isNumeric and isPositiveInt', () => {
  assert.equal(isNumeric('12345'), null);
  assert.notEqual(isNumeric('12a'), null);
  assert.equal(isPositiveInt('3'), null);
  assert.notEqual(isPositiveInt('0'), null);
  assert.notEqual(isPositiveInt('-1'), null);
});

test('isIpv4 accepts dotted quads, rejects garbage', () => {
  assert.equal(isIpv4('10.0.0.1'), null);
  assert.equal(isIpv4('192.168.1.255'), null);
  assert.notEqual(isIpv4('256.0.0.1'), null);
  assert.notEqual(isIpv4('nope'), null);
});

test('fieldsFor(mono) includes MASTER_SECRET and telegram creds', () => {
  const keys = fieldsFor('mono').map((f) => f.key);
  assert.ok(keys.includes('TELEGRAM_API_ID'));
  assert.ok(keys.includes('MASTER_SECRET'));
  assert.ok(keys.includes('REDIS_PASSWORD'));
});

test('fieldsFor(core) includes CORE_PRIVATE_IP + GO_HOST', () => {
  const keys = fieldsFor('core').map((f) => f.key);
  assert.ok(keys.includes('CORE_PRIVATE_IP'));
  assert.ok(keys.includes('GO_HOST'));
});

test('fieldsFor(go) includes GO_PRIVATE_IP + CORE_HOST', () => {
  const keys = fieldsFor('go').map((f) => f.key);
  assert.ok(keys.includes('GO_PRIVATE_IP'));
  assert.ok(keys.includes('CORE_HOST'));
});

test('fieldsFor(go) includes transfer-domain + SSL fields', () => {
  const keys = fieldsFor('go').map((f) => f.key);
  assert.ok(keys.includes('TRANSFER_DOMAIN'));
  assert.ok(keys.includes('SSL_CERT_FILE'));
  assert.ok(keys.includes('SSL_KEY_FILE'));
});

test('isFilename accepts bare names + empty, rejects paths', () => {
  assert.equal(isFilename('cert.pem'), null);
  assert.equal(isFilename(''), null); // optional → empty allowed
  assert.notEqual(isFilename('a/b.pem'), null);
  assert.notEqual(isFilename('a\\b.pem'), null);
});

test('isHostname accepts bare host, rejects scheme/path', () => {
  assert.equal(isHostname('dl.example.com'), null);
  assert.equal(isHostname('dl.example.com:8443'), null);
  assert.notEqual(isHostname('https://dl.example.com'), null);
  assert.notEqual(isHostname('dl.example.com/files'), null);
});

test('validateValues(go) fails without TRANSFER_DOMAIN, passes with it + blank SSL', () => {
  const base = {
    CORE_HOST: 'core.internal',
    GO_PRIVATE_IP: '10.0.0.2',
    UPLOAD_BUFFER_NFS: '/mnt/buffer',
    REDIS_PASSWORD: 'shared',
    TELEGRAM_API_ID: '123456',
    TELEGRAM_API_HASH: 'abcdef0123456789abcdef0123456789',
    TELEGRAM_BOT_TOKEN: '123:abc',
    TELEGRAM_CHAT_ID: '-100123',
    DATABASE_URL: 'postgresql://u:p@core:5432/app',
    JWT_SECRET: 'jwtsecret',
    MASTER_SECRET: 'a'.repeat(32),
  };
  assert.ok(validateValues('go', base).some((e) => e.startsWith('TRANSFER_DOMAIN')));
  assert.deepEqual(validateValues('go', { ...base, TRANSFER_DOMAIN: 'dl.example.com' }), []);
});

test('validateValues reports missing required and bad values', () => {
  const errs = validateValues('mono', { MASTER_SECRET: 'short' });
  assert.ok(errs.some((e) => e.startsWith('TELEGRAM_API_ID')));
  assert.ok(errs.some((e) => e.includes('MASTER_SECRET')));
});

test('validateValues passes a fully valid mono set', () => {
  const errs = validateValues('mono', {
    TELEGRAM_API_ID: '123456',
    TELEGRAM_API_HASH: 'abcdef0123456789abcdef0123456789',
    TELEGRAM_BOT_TOKEN: '123:abc',
    TELEGRAM_CHAT_ID: '-100123',
    DATABASE_URL: 'postgresql://u:p@db:5432/app',
    JWT_SECRET: 'jwtsecret',
    MASTER_SECRET: 'a'.repeat(32),
    REDIS_PASSWORD: 'abc123',
  });
  assert.deepEqual(errs, []);
});

test('CDN validators', () => {
  assert.equal(isCdnMode('disabled'), null);
  assert.equal(isCdnMode('revalidate'), null);
  assert.equal(isCdnMode('full'), null);
  assert.notEqual(isCdnMode('sometimes'), null);
  assert.equal(isCdnTtl('3600'), null);
  assert.notEqual(isCdnTtl('10'), null);
  assert.notEqual(isCdnTtl('99999999'), null);
  assert.equal(isCdnWindow('0'), null);
  assert.equal(isCdnWindow('300'), null);
  assert.notEqual(isCdnWindow('99999'), null);
  assert.equal(isPurgeProvider('none'), null);
  assert.equal(isPurgeProvider('cloudflare'), null);
  assert.notEqual(isPurgeProvider('akamai'), null);
  assert.equal(isZoneId('a'.repeat(32)), null);
  assert.notEqual(isZoneId('abc'), null);
  assert.equal(isOriginUrl('https://dl.example.com'), null);
  assert.notEqual(isOriginUrl('https://dl.example.com/files'), null);
});

test('CDN fields join mono/scale/core but not go', () => {
  for (const t of ['mono', 'scale', 'core']) {
    const keys = fieldsFor(t).map((f) => f.key);
    assert.ok(keys.includes('CDN_CACHE_MODE'), t);
    assert.ok(keys.includes('CDN_CACHE_WINDOW_SECONDS'), t);
    assert.ok(keys.includes('CDN_PURGE_PROVIDER'), t);
  }
  const goKeys = fieldsFor('go').map((f) => f.key);
  assert.ok(!goKeys.includes('CDN_CACHE_MODE'));
  assert.ok(!goKeys.includes('CDN_PURGE_PROVIDER'));
});

test('validateValues accepts a full CDN set and rejects bad mode', () => {
  const base = {
    TELEGRAM_API_ID: '123456',
    TELEGRAM_API_HASH: 'abcdef0123456789abcdef0123456789',
    TELEGRAM_BOT_TOKEN: '123:abc',
    TELEGRAM_CHAT_ID: '-100123',
    DATABASE_URL: 'postgresql://u:p@db:5432/app',
    JWT_SECRET: 'jwtsecret',
    MASTER_SECRET: 'a'.repeat(32),
    REDIS_PASSWORD: 'abc123',
  };
  assert.deepEqual(validateValues('mono', base), []);
  assert.deepEqual(validateValues('mono', {
    ...base,
    CDN_CACHE_MODE: 'full',
    CDN_CACHE_TTL_SECONDS: '86400',
    CDN_CACHE_WINDOW_SECONDS: '300',
    CDN_PURGE_PROVIDER: 'cloudflare',
    CLOUDFLARE_API_TOKEN: 'tok',
    CDN_CACHE_PURGE_ZONE: 'a'.repeat(32),
    CDN_CACHE_PURGE_BASE: 'https://dl.example.com',
  }), []);
  assert.ok(validateValues('mono', { ...base, CDN_CACHE_MODE: 'elite' })
    .some((e) => e.startsWith('CDN_CACHE_MODE')));
});