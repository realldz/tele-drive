// scripts/installer/test/topology.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TOPOLOGIES, resolveTopology } from '../lib/topology.mjs';

test('TOPOLOGIES lists all four', () => {
  assert.deepEqual(TOPOLOGIES, ['mono', 'scale', 'core', 'go']);
});

test('mono maps to docker-compose.yml, scale 1', () => {
  const r = resolveTopology('mono');
  assert.equal(r.composeFile, 'docker-compose.yml');
  assert.equal(r.scale, 1);
  assert.equal(r.role, 'mono');
  assert.deepEqual(r.envFiles, ['.env']);
});

test('scale carries the scale count and same compose file', () => {
  const r = resolveTopology('scale', 3);
  assert.equal(r.composeFile, 'docker-compose.yml');
  assert.equal(r.scale, 3);
  assert.equal(r.role, 'mono');
});

test('scale defaults to 1 when count omitted', () => {
  assert.equal(resolveTopology('scale').scale, 1);
});

test('core maps to docker-compose.core.yml + .env.core', () => {
  const r = resolveTopology('core');
  assert.equal(r.composeFile, 'docker-compose.core.yml');
  assert.equal(r.role, 'core');
  assert.deepEqual(r.envFiles, ['.env.core']);
});

test('go maps to docker-compose.transfer.yml + .env.transfer', () => {
  const r = resolveTopology('go');
  assert.equal(r.composeFile, 'docker-compose.transfer.yml');
  assert.equal(r.role, 'go');
  assert.deepEqual(r.envFiles, ['.env.transfer']);
});

test('unknown topology throws', () => {
  assert.throws(() => resolveTopology('bogus'));
});
