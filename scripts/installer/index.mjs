// scripts/installer/index.mjs
// Wizard entry: collect config → validate → write env files → emit .installer-plan.json.
// Runs inside an ephemeral node:22-alpine container mounted at /repo.

import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

import { parseArgs } from './lib/args.mjs';
import { fieldsFor, validateValues } from './lib/env-schema.mjs';
import { ensureRedisPassword } from './lib/secrets.mjs';
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

  // Collect.
  let values;
  if (args.interactive) {
    values = await promptFields(rl, fields, currentValues);
  } else {
    values = { ...currentValues };
  }
  if (rl) rl.close();

  // Idempotent secret.
  values.REDIS_PASSWORD = ensureRedisPassword(values.REDIS_PASSWORD);

  // Validate — on failure write NOTHING.
  const errors = validateValues(topology, values);
  if (errors.length) {
    die(`Validation failed — no files written:\n  ${errors.join('\n  ')}`, 1);
  }

  // Group updates per file and write atomically.
  const envFilesWritten = [];
  for (const file of targetFiles) {
    const updates = {};
    for (const f of fields) {
      if (f.file === file && values[f.key] !== undefined) updates[f.key] = values[f.key];
    }
    const rendered = renderEnv(parsedByFile[file], updates);
    atomicWrite(file, rendered);
    envFilesWritten.push(file);
  }

  // Emit the plan for bash.
  const plan = buildPlan({ topology, scale, build: args.build, envFilesWritten });
  atomicWrite('.installer-plan.json', JSON.stringify(plan, null, 2) + '\n');

  console.log(`\nWrote: ${envFilesWritten.join(', ')}, .installer-plan.json`);

  if (topology === 'core' || topology === 'go') {
    console.log('\n[multi-host] Copy these to the OTHER host and keep them identical:');
    console.log('  - certs/grpc/*  (gRPC mTLS trust)');
    console.log('  - REDIS_PASSWORD (must match between core and go)');
  }
  if (topology === 'scale') {
    console.log(`\n[scale] Booting ${scale} backend-transfer replicas. Each gets a unique INSTANCE_ID from its container hostname.`);
    console.log('  If hosts ever share a hostname, set INSTANCE_ID explicitly (see docs/horizontal-scaling/multi-instance-monitoring.md).');
  }
}

main().catch((err) => die(`Installer error: ${err.message}`, 1));
