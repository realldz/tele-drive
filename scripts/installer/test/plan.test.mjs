// scripts/installer/test/plan.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPlan } from '../lib/plan.mjs';

test('mono plan: ghcr overlay, no scaleTransfer, no env-file, certs needed', () => {
  const p = buildPlan({ topology: 'mono', scale: 1, source: 'ghcr', envFilesWritten: ['.env', 'backend/.env'] });
  assert.equal(p.composeFile, 'docker-compose.yml');
  assert.equal(p.overlayFile, 'docker-compose.ghcr.yml');
  assert.equal(p.build, false);
  assert.equal(p.scaleTransfer, null);
  assert.equal(p.envFile, '');
  assert.equal(p.needCerts, true);
  assert.equal(p.role, 'mono');
  assert.equal(p.externalDb, false);
  assert.deepEqual(p.envFilesWritten, ['.env', 'backend/.env']);
});

test('scale plan carries scaleTransfer', () => {
  const p = buildPlan({ topology: 'scale', scale: 3, source: 'ghcr', envFilesWritten: ['.env', 'backend/.env'] });
  assert.equal(p.composeFile, 'docker-compose.yml');
  assert.equal(p.scaleTransfer, 3);
});

test('build source sets build true and drops the pull overlay', () => {
  const p = buildPlan({ topology: 'mono', scale: 1, source: 'build', envFilesWritten: [] });
  assert.equal(p.build, true);
  assert.equal(p.imageSource, 'build');
  assert.equal(p.overlayFile, '');
});

test('core plan uses core compose file + role + env-file', () => {
  const p = buildPlan({ topology: 'core', scale: 1, source: 'ghcr', envFilesWritten: ['.env.core', 'backend/.env'] });
  assert.equal(p.composeFile, 'docker-compose.core.yml');
  assert.equal(p.role, 'core');
  assert.equal(p.scaleTransfer, null);
  assert.equal(p.envFile, '.env.core');
  assert.equal(p.externalDb, false);
});

test('core plan flags an external db so bash adds the extdb overlay', () => {
  const p = buildPlan({ topology: 'core', scale: 1, source: 'ghcr', externalDb: true, dbHost: '10.0.0.9', envFilesWritten: ['.env.core'] });
  assert.equal(p.externalDb, true);
  assert.equal(p.dbHost, '10.0.0.9');
});

test('go plan uses transfer compose file + role, no certs minted', () => {
  const p = buildPlan({ topology: 'go', scale: 1, source: 'ghcr', envFilesWritten: ['.env.transfer', 'backend/.env'] });
  assert.equal(p.composeFile, 'docker-compose.transfer.yml');
  assert.equal(p.role, 'go');
  assert.equal(p.envFile, '.env.transfer');
  assert.equal(p.needCerts, false);
});

test('db plan: db compose file, no overlay, no certs, .env.db', () => {
  const p = buildPlan({ topology: 'db', scale: 1, source: 'ghcr', envFilesWritten: ['.env.db'] });
  assert.equal(p.composeFile, 'docker-compose.db.yml');
  assert.equal(p.role, 'db');
  // Nothing of ours is pulled on a db host — install.sh must not append -f "".
  assert.equal(p.overlayFile, '');
  assert.equal(p.needCerts, false);
  assert.equal(p.envFile, '.env.db');
  assert.equal(p.scaleTransfer, null);
});