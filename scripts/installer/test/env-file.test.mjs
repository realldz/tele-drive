// scripts/installer/test/env-file.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseEnv, getValue, renderEnv } from '../lib/env-file.mjs';

test('round-trip preserves comments, blanks, and order when no updates', () => {
  const src = '# header\nFOO=1\n\n# section\nBAR=two\n';
  const parsed = parseEnv(src);
  assert.equal(renderEnv(parsed, {}), src);
});

test('getValue returns current value and undefined for missing', () => {
  const parsed = parseEnv('FOO=1\nBAR=two\n');
  assert.equal(getValue(parsed, 'FOO'), '1');
  assert.equal(getValue(parsed, 'BAR'), 'two');
  assert.equal(getValue(parsed, 'NOPE'), undefined);
});

test('overwrite changes only the targeted key, in place', () => {
  const src = '# c\nFOO=1\nBAR=two\n';
  const parsed = parseEnv(src);
  assert.equal(renderEnv(parsed, { FOO: '9' }), '# c\nFOO=9\nBAR=two\n');
});

test('append adds new keys after existing content', () => {
  const src = 'FOO=1\n';
  const parsed = parseEnv(src);
  assert.equal(renderEnv(parsed, { NEW: 'x' }), 'FOO=1\nNEW=x\n');
});

test('value containing = is preserved on parse', () => {
  const parsed = parseEnv('URL=redis://:p=w@h:6379\n');
  assert.equal(getValue(parsed, 'URL'), 'redis://:p=w@h:6379');
});

test('surrounding double quotes are stripped from parsed value', () => {
  const parsed = parseEnv('SECRET="0123456789abcdef0123456789abcdef"\n');
  assert.equal(getValue(parsed, 'SECRET'), '0123456789abcdef0123456789abcdef');
});

test('surrounding single quotes are stripped from parsed value', () => {
  const parsed = parseEnv("URL='postgresql://u:p@h:5432/db'\n");
  assert.equal(getValue(parsed, 'URL'), 'postgresql://u:p@h:5432/db');
});

test('unbalanced or inner quotes are left intact', () => {
  assert.equal(getValue(parseEnv('A="unbalanced\n'), 'A'), '"unbalanced');
  assert.equal(getValue(parseEnv('B=say "hi"\n'), 'B'), 'say "hi"');
  assert.equal(getValue(parseEnv('C=""\n'), 'C'), '');
});

test('empty input renders only appended keys with trailing newline', () => {
  const parsed = parseEnv('');
  assert.equal(renderEnv(parsed, { A: '1', B: '2' }), 'A=1\nB=2\n');
});
