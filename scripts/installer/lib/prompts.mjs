// scripts/installer/lib/prompts.mjs
// Interactive readline prompts. Pure validation lives in env-schema.

import { TOPOLOGIES } from './topology.mjs';

const TOPOLOGY_LABELS = {
  mono: 'single-host, 1 instance',
  scale: 'single-host, N replicas',
  core: 'multi-host, control plane (core)',
  go: 'multi-host, data plane (go)',
};

export async function promptTopology(rl) {
  console.log('\nSelect deployment topology:');
  TOPOLOGIES.forEach((t, i) => console.log(`  ${i + 1}) ${t} — ${TOPOLOGY_LABELS[t]}`));
  for (;;) {
    const ans = (await rl.question('Topology [1-4]: ')).trim();
    const idx = Number(ans) - 1;
    if (Number.isInteger(idx) && idx >= 0 && idx < TOPOLOGIES.length) return TOPOLOGIES[idx];
    console.error('Please enter a number between 1 and 4.');
  }
}

export async function promptScale(rl) {
  for (;;) {
    const ans = (await rl.question('Number of backend-transfer replicas [2]: ')).trim();
    if (ans === '') return 2;
    if (/^\d+$/.test(ans) && Number(ans) >= 1) return Number(ans);
    console.error('Please enter an integer >= 1.');
  }
}

export async function promptFields(rl, fields, currentValues) {
  const values = { ...currentValues };
  for (const f of fields) {
    const current = currentValues[f.key];
    const shown = current !== undefined && current !== '' ? (f.secret ? '******' : current) : '(none)';
    for (;;) {
      const ans = (await rl.question(`${f.prompt} [${shown}]: `)).trim();
      const value = ans === '' ? (current ?? '') : ans;
      if (value === '' && f.required && f.key !== 'REDIS_PASSWORD') {
        console.error(`${f.key} is required.`);
        continue;
      }
      if (value !== '' && f.validate) {
        const err = f.validate(value);
        if (err) { console.error(`${f.key}: ${err}`); continue; }
      }
      values[f.key] = value;
      break;
    }
  }
  return values;
}
