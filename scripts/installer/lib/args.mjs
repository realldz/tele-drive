// scripts/installer/lib/args.mjs
// Parse installer CLI flags into a structured, validated object.

import { TOPOLOGIES } from './topology.mjs';

export function parseArgs(argv) {
  const out = { topology: null, scale: null, build: true, interactive: true, errors: [] };
  for (const arg of argv) {
    if (arg === '--no-build') { out.build = false; continue; }
    if (arg === '--non-interactive') { out.interactive = false; continue; }
    if (arg.startsWith('--topology=')) {
      const v = arg.slice('--topology='.length);
      if (!TOPOLOGIES.includes(v)) out.errors.push(`invalid --topology: ${v} (expected ${TOPOLOGIES.join('|')})`);
      else out.topology = v;
      continue;
    }
    if (arg.startsWith('--scale=')) {
      const v = arg.slice('--scale='.length);
      if (!/^\d+$/.test(v) || Number(v) < 1) out.errors.push(`invalid --scale: ${v} (expected integer >= 1)`);
      else out.scale = Number(v);
      continue;
    }
    out.errors.push(`unknown flag: ${arg}`);
  }
  return out;
}
