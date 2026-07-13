// scripts/installer/test/plan.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPlan } from '../lib/plan.mjs';

test('mono plan: no scaleTransfer, build true, needCerts true', () => {
  const p = buildPlan({ topology: 'mono', scale: 1, build: true, envFilesWritten: ['.env', 'backend/.env'] });
  assert.equal(p.composeFile, 'docker-compose.yml');
  assert.equal(p.build, true);
  assert.equal(p.scaleTransfer, null);
  assert.equal(p.needCerts, true);
  assert.equal(p.role, 'mono');
  assert.deepEqual(p.envFilesWritten, ['.env', 'backend/.env']);
});

test('scale plan carries scaleTransfer', () => {
  const p = buildPlan({ topology: 'scale', scale: 3, build: true, envFilesWritten: ['.env', 'backend/.env'] });
  assert.equal(p.composeFile, 'docker-compose.yml');
  assert.equal(p.scaleTransfer, 3);
});

test('no-build plan sets build false', () => {
  const p = buildPlan({ topology: 'mono', scale: 1, build: false, envFilesWritten: [] });
  assert.equal(p.build, false);
});

test('core plan uses core compose file + role', () => {
  const p = buildPlan({ topology: 'core', scale: 1, build: true, envFilesWritten: ['.env.core', 'backend/.env'] });
  assert.equal(p.composeFile, 'docker-compose.core.yml');
  assert.equal(p.role, 'core');
  assert.equal(p.scaleTransfer, null);
});

test('go plan uses transfer compose file + role', () => {
  const p = buildPlan({ topology: 'go', scale: 1, build: true, envFilesWritten: ['.env.transfer', 'backend/.env'] });
  assert.equal(p.composeFile, 'docker-compose.transfer.yml');
  assert.equal(p.role, 'go');
});
