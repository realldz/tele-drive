// scripts/installer/test/secrets.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateRedisPassword, ensureRedisPassword } from '../lib/secrets.mjs';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));

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

test('db installer keeps the Postgres password out of stdout and the plan', () => {
  const workDir = mkdtempSync(join(tmpdir(), 'tele-drive-installer-'));
  const password = 'NeverPrintThisPostgresPassword123';

  try {
    writeFileSync(
      join(workDir, '.env.db'),
      [
        'DB_PRIVATE_IP=10.0.0.9',
        'DB_PORT=5432',
        'POSTGRES_USER=tele_drive',
        'POSTGRES_DB=tele_drive',
        `POSTGRES_PASSWORD=${password}`,
        '',
      ].join('\n'),
    );

    const result = spawnSync(
      process.execPath,
      [join(TEST_DIR, '..', 'index.mjs'), '--topology=db', '--non-interactive'],
      { cwd: workDir, encoding: 'utf8' },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stdout, new RegExp(password));
    assert.match(
      result.stdout,
      /POSTGRES_PASSWORD=<the value in \.env\.db on this host>/,
    );
    assert.match(readFileSync(join(workDir, '.env.db'), 'utf8'), new RegExp(password));
    assert.doesNotMatch(
      readFileSync(join(workDir, '.installer-plan.json'), 'utf8'),
      new RegExp(password),
    );
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});
