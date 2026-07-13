// scripts/installer/test/secrets.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateRedisPassword, ensureRedisPassword } from '../lib/secrets.mjs';

test('generateRedisPassword is alphanumeric and correct length', () => {
  const pw = generateRedisPassword(40);
  assert.equal(pw.length, 40);
  assert.match(pw, /^[A-Za-z0-9]+$/);
});

test('generateRedisPassword is random across calls', () => {
  assert.notEqual(generateRedisPassword(40), generateRedisPassword(40));
});

test('ensureRedisPassword keeps an existing value', () => {
  assert.equal(ensureRedisPassword('keepme'), 'keepme');
});

test('ensureRedisPassword generates when missing or empty', () => {
  assert.match(ensureRedisPassword(undefined), /^[A-Za-z0-9]{40}$/);
  assert.match(ensureRedisPassword(''), /^[A-Za-z0-9]{40}$/);
});
