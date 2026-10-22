// scripts/installer/test/env-schema.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isExact32, isNumeric, isPositiveInt, isIpv4, isFilename, isHostname,
  fieldsFor, validateValues, isCdnMode, isCdnTtl, isCdnWindow, isPurgeProvider, isZoneId, isOriginUrl, isCdnPublicS3Mode,
  isPort, isDbHost, isDbIdentifier, isDbPassword, deriveValues,
} from '../lib/env-schema.mjs';
import { promptFields } from '../lib/prompts.mjs';

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
test('isCdnPublicS3Mode accepts inherit and the cache modes', () => {
  assert.equal(isCdnPublicS3Mode('inherit'), null);
  assert.equal(isCdnPublicS3Mode('full'), null);
  assert.equal(isCdnPublicS3Mode('revalidate'), null);
  assert.equal(isCdnPublicS3Mode('disabled'), null);
});

test('isCdnPublicS3Mode rejects garbage and whitespace-padded values', () => {
  assert.notEqual(isCdnPublicS3Mode('inherit '), null);
  assert.notEqual(isCdnPublicS3Mode('url'), null);
  assert.notEqual(isCdnPublicS3Mode(''), null);
});

test('db-only validators: port, host, identifier, password', () => {
  assert.equal(isPort('5432'), null);
  assert.notEqual(isPort('0'), null);
  assert.notEqual(isPort('70000'), null);
  assert.notEqual(isPort('54a'), null);
  assert.equal(isDbHost('10.0.0.9'), null);
  assert.equal(isDbHost('db.internal'), null);
  assert.notEqual(isDbHost('postgresql://h:5432'), null);
  assert.notEqual(isDbHost('dc1 host'), null);
  assert.equal(isDbIdentifier('tele_drive'), null);
  assert.notEqual(isDbIdentifier('Tele-Drive'), null);
  assert.equal(isDbPassword('a-b_c.9'), null);
  assert.notEqual(isDbPassword('has space'), null);
});

test('fieldsFor(db) is just bind IP + Postgres credentials', () => {
  const keys = fieldsFor('db').map((f) => f.key);
  assert.deepEqual(keys, ['DB_PRIVATE_IP', 'DB_PORT', 'POSTGRES_USER', 'POSTGRES_DB', 'POSTGRES_PASSWORD']);
  // No backend/Redis/telegram fields: a db host runs none of those processes.
  for (const k of ['DATABASE_URL', 'REDIS_PASSWORD', 'TELEGRAM_BOT_TOKEN', 'MASTER_SECRET']) {
    assert.ok(!keys.includes(k), k);
  }
});

test('validateValues(db) requires DB_PRIVATE_IP and tolerates a blank password', () => {
  assert.ok(validateValues('db', {}).some((e) => e.startsWith('DB_PRIVATE_IP')));
  assert.deepEqual(validateValues('db', { DB_PRIVATE_IP: '10.0.0.9', POSTGRES_PASSWORD: '' }), []);
  assert.ok(validateValues('db', { DB_PRIVATE_IP: 'nope' }).some((e) => e.startsWith('DB_PRIVATE_IP')));
});

const CORE_BASE = {
  GO_HOST: '10.0.0.2',
  CORE_PRIVATE_IP: '10.0.0.1',
  UPLOAD_BUFFER_NFS: '/mnt/buffer',
  REDIS_PASSWORD: 'redispass',
  TELEGRAM_BOT_TOKEN: '123:abc',
  TELEGRAM_CHAT_ID: '-100123',
  DATABASE_URL: 'postgresql://u:p@postgres:5432/app',
  JWT_SECRET: 'jwtsecret',
  MASTER_SECRET: 'a'.repeat(32),
};

test('validateValues(core) demands POSTGRES_PASSWORD once DB_HOST is set', () => {
  assert.deepEqual(validateValues('core', CORE_BASE), []);
  const errs = validateValues('core', { ...CORE_BASE, DB_HOST: '10.0.0.9' });
  assert.ok(errs.some((e) => e.startsWith('POSTGRES_PASSWORD')));
  assert.deepEqual(validateValues('core', { ...CORE_BASE, DB_HOST: '10.0.0.9', POSTGRES_PASSWORD: 'pw' }), []);
});

test('deriveValues builds DATABASE_URL only for an external-db core host', () => {
  assert.deepEqual(deriveValues('core', {}), []);
  assert.deepEqual(deriveValues('core', { DB_HOST: '', POSTGRES_PASSWORD: 'pw' }), []);
  assert.deepEqual(deriveValues('mono', { DB_HOST: '10.0.0.9', POSTGRES_PASSWORD: 'pw' }), []);
  // No password → no URL (validation already failed the run).
  assert.deepEqual(deriveValues('core', { DB_HOST: '10.0.0.9', POSTGRES_PASSWORD: '' }), []);

  const [d] = deriveValues('core', {
    DB_HOST: '10.0.0.9',
    POSTGRES_PASSWORD: 'p@ss',
    POSTGRES_DB: 'td',
    DB_PORT: '5440',
  });
  assert.equal(d.key, 'DATABASE_URL');
  assert.equal(d.file, '.env.core');
  assert.equal(d.value, 'postgresql://tele_drive:p%40ss@10.0.0.9:5440/td');
});

test('deriveValues defaults user/db/port when the optional fields are blank', () => {
  const [d] = deriveValues('core', { DB_HOST: 'db.internal', POSTGRES_PASSWORD: 'pw' });
  assert.equal(d.value, 'postgresql://tele_drive:pw@db.internal:5432/tele_drive');
});

test('validateValues(core) accepts an empty DATABASE_URL when it will be derived', () => {
  const errs = validateValues('core', {
    ...CORE_BASE,
    DATABASE_URL: '',
    DB_HOST: '10.0.0.9',
    POSTGRES_PASSWORD: 'pw',
  });
  assert.deepEqual(errs, []);
  // Without DB_HOST the field is still mandatory: nothing would derive it.
  assert.ok(validateValues('core', { ...CORE_BASE, DATABASE_URL: '' }).some((e) => e.startsWith('DATABASE_URL')));
});

test('promptFields never asks for DATABASE_URL on an external-DB core host', async () => {
  const asked = [];
  const rl = { question: async (q) => { asked.push(q); return ''; } };
  const fields = [
    { key: 'DB_HOST', prompt: 'DB host', required: true },
    { key: 'DATABASE_URL', prompt: 'Postgres connection URL', required: true },
    { key: 'DB_PORT', prompt: 'DB port', required: false },
  ];
  const values = await promptFields(rl, fields, { DB_HOST: '10.0.0.9' });
  assert.equal(asked.length, 2);
  assert.ok(asked.every((q) => !q.includes('DATABASE_URL')));
  assert.equal(values.DATABASE_URL, undefined);
});

test('promptFields still asks for DATABASE_URL when the DB is local', async () => {
  const asked = [];
  const rl = { question: async (q) => { asked.push(q); return 'postgresql://u:p@postgres:5432/app'; } };
  const values = await promptFields(rl, [{ key: 'DATABASE_URL', prompt: 'Postgres URL', required: true }], {});
  assert.equal(asked.length, 1);
  assert.equal(values.DATABASE_URL, 'postgresql://u:p@postgres:5432/app');
});
