// scripts/installer/test/env-schema.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isExact32, isNumeric, isPositiveInt, isIpv4,
  fieldsFor, validateValues,
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
