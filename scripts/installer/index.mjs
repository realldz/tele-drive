// scripts/installer/index.mjs
// Wizard entry: collect config → validate → write env files → emit .installer-plan.json.
// Runs inside an ephemeral node:22-alpine container mounted at /repo.

import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

import { parseArgs } from './lib/args.mjs';
import { fieldsFor, validateValues, deriveValues } from './lib/env-schema.mjs';
import { ensureRedisPassword, ensurePostgresPassword } from './lib/secrets.mjs';
import { parseEnv, getValue, renderEnv } from './lib/env-file.mjs';
import { buildPlan } from './lib/plan.mjs';
import { promptTopology, promptScale, promptFields } from './lib/prompts.mjs';

function readFileSafe(path) {
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

function atomicWrite(path, content) {
  const dir = dirname(path);
  if (dir && dir !== '.' && !existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, content, { mode: 0o600 });
  renameSync(tmp, path);
}

function die(msg, code = 1) {
  console.error(msg);
  process.exit(code);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.errors.length) die(`Argument error:\n  ${args.errors.join('\n  ')}`, 2);

  const rl = args.interactive ? createInterface({ input: stdin, output: stdout }) : null;

  let topology = args.topology;
  if (!topology) {
    if (!args.interactive) die('--topology is required in --non-interactive mode', 2);
    topology = await promptTopology(rl);
  }

  let scale = args.scale ?? 1;
  if (topology === 'scale') {
    if (args.scale) scale = args.scale;
    else if (args.interactive) scale = await promptScale(rl);
    else scale = 1;
  }

  const fields = fieldsFor(topology);

  // Seed current values from the files this topology touches.
  const targetFiles = [...new Set(fields.map((f) => f.file))];
  const parsedByFile = Object.fromEntries(
    targetFiles.map((file) => [file, parseEnv(readFileSafe(file))]),
  );
  const currentValues = {};
  for (const f of fields) {
    const v = getValue(parsedByFile[f.file], f.key);
    if (v !== undefined) currentValues[f.key] = v;
  }

  // CLI overrides win over whatever the env files currently hold, so
  // `--image-tag=1.2.3` both prefills the interactive prompt and pins the
  // non-interactive write.
  if (args.imageTag !== null) currentValues.TELE_DRIVE_IMAGE_TAG = args.imageTag;
  if (args.imagePrefix !== null) currentValues.TELE_DRIVE_IMAGE_PREFIX = args.imagePrefix;

  // Collect.
  let values;
  if (args.interactive) {
    values = await promptFields(rl, fields, currentValues);
  } else {
    values = { ...currentValues };
  }
  if (rl) rl.close();

  // Idempotent secrets. Only topologies that actually carry the field generate
  // one — injecting REDIS_PASSWORD into .env.db would just be noise.
  const hasField = (key) => fields.some((f) => f.key === key);
  if (hasField('REDIS_PASSWORD')) values.REDIS_PASSWORD = ensureRedisPassword(values.REDIS_PASSWORD);
  // The db host OWNS the Postgres password, so it may generate one. A core host
  // pointing at it must use that same value: a blank one is a validation error
  // below, never silently regenerated (that would not match the db host).
  if (topology === 'db') values.POSTGRES_PASSWORD = ensurePostgresPassword(values.POSTGRES_PASSWORD);

  // Validate — on failure write NOTHING.
  const errors = validateValues(topology, values);
  if (errors.length) {
    die(`Validation failed — no files written:\n  ${errors.join('\n  ')}`, 1);
  }

  // Computed values (today: DATABASE_URL for a core host that points at a
  // db-only host) ride the same atomic per-file write as the prompted ones.
  const derived = deriveValues(topology, values);
  const derivedByFile = {};
  for (const d of derived) (derivedByFile[d.file] ??= {})[d.key] = d.value;
  const filesToWrite = [...new Set([...targetFiles, ...derived.map((d) => d.file)])];

  // Group updates per file and write atomically.
  const envFilesWritten = [];
  for (const file of filesToWrite) {
    const updates = {};
    for (const f of fields) {
      if (f.file === file && values[f.key] !== undefined) updates[f.key] = values[f.key];
    }
    Object.assign(updates, derivedByFile[file] ?? {});
    const base = parsedByFile[file] ?? parseEnv(readFileSafe(file));
    const rendered = renderEnv(base, updates);
    atomicWrite(file, rendered);
    envFilesWritten.push(file);
  }

  // Emit the plan for bash.
  const plan = buildPlan({
    topology, scale,
    source: args.source,
    imageTag: values.TELE_DRIVE_IMAGE_TAG ?? args.imageTag ?? '',
    imagePrefix: values.TELE_DRIVE_IMAGE_PREFIX ?? args.imagePrefix ?? '',
    envFilesWritten,
    externalDb: topology === 'core' && Boolean(values.DB_HOST),
    // Where the DB lives, per role: the core host dials DB_HOST, the db host IS
    // DB_PRIVATE_IP. install.sh prints it back to the operator.
    dbHost: topology === 'db' ? (values.DB_PRIVATE_IP ?? '') : (values.DB_HOST ?? ''),
  });
  atomicWrite('.installer-plan.json', JSON.stringify(plan, null, 2) + '\n');

  console.log(`\nWrote: ${envFilesWritten.join(', ')}, .installer-plan.json`);

  if (topology === 'db') {
    console.log('\n[image] db host runs postgres:16-alpine only — no Tele-Drive image is built or pulled.');
  } else if (args.source === 'ghcr') {
    console.log(`\n[image] Pulling prebuilt images (${plan.imagePrefix || 'ghcr.io/realldz/tele-drive'}:*) tag=${plan.imageTag || 'latest'}.`);
    console.log('  Pin releases via --image-tag; swap registry via --image-prefix (forks).');
  } else {
    console.log('\n[image] Building all images on this host (--build). No GHCR pull.');
  }

  if (topology === 'core' || topology === 'go') {
    console.log('\n[multi-host] Copy these to the OTHER host and keep them identical:');
    console.log('  - certs/grpc/*  (gRPC mTLS trust)');
    console.log('  - REDIS_PASSWORD (must match between core and go)');
  }
  if (topology === 'scale') {
    console.log(`\n[scale] Booting ${scale} backend-transfer replicas. Each gets a unique INSTANCE_ID from its container hostname.`);
    console.log('  If hosts ever share a hostname, set INSTANCE_ID explicitly (see docs/horizontal-scaling/multi-instance-monitoring.md).');
  }
  if (topology === 'db') {
    const dbPort = values.DB_PORT || '5432';
    const dbUser = values.POSTGRES_USER || 'tele_drive';
    const dbName = values.POSTGRES_DB || 'tele_drive';
    console.log('\n[db] Postgres only on this host — no backend, no Redis, no gRPC certs.');
    console.log('  On the CONTROL-PLANE host, put this in .env.core (or rerun the wizard with --topology=core):');
    console.log(`    DB_HOST=${values.DB_PRIVATE_IP ?? ''}`);
    console.log(`    DB_PORT=${dbPort}`);
    console.log(`    POSTGRES_USER=${dbUser}`);
    console.log(`    POSTGRES_DB=${dbName}`);
    console.log(`    POSTGRES_PASSWORD=${values.POSTGRES_PASSWORD ?? ''}`);
    console.log('  Deploy core WITH -f docker-compose.core.extdb.yml so it never starts a local Postgres.');
    console.log(`  Firewall ${dbPort} on this host to the CORE host only.`);
  }
  if (topology === 'core' && values.DB_HOST) {
    console.log(`\n[db] External Postgres at ${values.DB_HOST}:${values.DB_PORT || '5432'} — deploy core with -f docker-compose.core.extdb.yml.`);
  }
}

main().catch((err) => die(`Installer error: ${err.message}`, 1));