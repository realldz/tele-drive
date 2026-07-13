// scripts/installer/test/args.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs } from '../lib/args.mjs';

test('defaults: build true, interactive true, no topology', () => {
  const a = parseArgs([]);
  assert.equal(a.build, true);
  assert.equal(a.interactive, true);
  assert.equal(a.topology, null);
  assert.deepEqual(a.errors, []);
});

test('parses topology and scale', () => {
  const a = parseArgs(['--topology=scale', '--scale=4']);
  assert.equal(a.topology, 'scale');
  assert.equal(a.scale, 4);
  assert.deepEqual(a.errors, []);
});

test('--no-build and --non-interactive', () => {
  const a = parseArgs(['--no-build', '--non-interactive']);
  assert.equal(a.build, false);
  assert.equal(a.interactive, false);
});

test('rejects unknown topology', () => {
  const a = parseArgs(['--topology=bogus']);
  assert.ok(a.errors.some((e) => e.includes('topology')));
});

test('rejects non-positive scale', () => {
  assert.ok(parseArgs(['--scale=0']).errors.length > 0);
  assert.ok(parseArgs(['--scale=x']).errors.length > 0);
});

test('rejects unknown flag', () => {
  assert.ok(parseArgs(['--wat']).errors.some((e) => e.includes('--wat')));
});
