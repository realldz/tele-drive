// scripts/installer/test/args.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs } from '../lib/args.mjs';

test('defaults: ghcr source, interactive true, no topology', () => {
  const a = parseArgs([]);
  assert.equal(a.source, 'ghcr');
  assert.equal(a.interactive, true);
  assert.equal(a.topology, null);
  assert.equal(a.imageTag, null);
  assert.equal(a.imagePrefix, null);
  assert.deepEqual(a.errors, []);
});

test('parses topology and scale', () => {
  const a = parseArgs(['--topology=scale', '--scale=4']);
  assert.equal(a.topology, 'scale');
  assert.equal(a.scale, 4);
  assert.deepEqual(a.errors, []);
});

test('parses the db-only topology', () => {
  const a = parseArgs(['--topology=db', '--non-interactive']);
  assert.equal(a.topology, 'db');
  assert.equal(a.interactive, false);
  assert.deepEqual(a.errors, []);
});

test('--build and --no-build select the image source', () => {
  assert.equal(parseArgs(['--build']).source, 'build');
  assert.equal(parseArgs(['--no-build']).source, 'ghcr');
  assert.equal(parseArgs(['--source=build']).source, 'build');
  assert.ok(parseArgs(['--source=nope']).errors.length > 0);
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