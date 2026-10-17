// scripts/installer/lib/args.mjs
// Parse installer CLI flags into a structured, validated object.

import { TOPOLOGIES } from './topology.mjs';

// Image deploy mode: "ghcr" pulls the prebuilt images CI publishes
// (ghcr.io/<owner>/tele-drive-* via a docker-compose*.ghcr.yml overlay); "build"
// compiles them on this host like the installer did before GHCR existed.
const IMAGE_SOURCES = ['ghcr', 'build'];

// Docker tag charset — sha-1a2b3c4, master, 1.2.3. Disallows everything a shell
// or compose interpolation could misread.
export const isImageTag = (v) =>
  /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(v || '')
    ? null
    : 'must be a valid image tag (letters, digits, . _ -)';
// Registry/repository path (ghcr.io/realldz/tele-drive). Lowercase: GHCR paths
// are lowercase — the CI workflow lowercases the owner before pushing.
export const isImagePrefix = (v) =>
  /^[a-z0-9][a-z0-9./_-]*$/.test(v || '')
    ? null
    : 'must be a lowercase registry path (registry/owner/repo)';

export function parseArgs(argv) {
  const out = {
    topology: null, scale: null,
    source: 'ghcr', imageTag: null, imagePrefix: null,
    interactive: true, errors: [],
  };
  for (const arg of argv) {
    if (arg === '--build') { out.source = 'build'; continue; }
    if (arg === '--no-build') { out.source = 'ghcr'; continue; } // legacy alias for the new default
    if (arg === '--non-interactive') { out.interactive = false; continue; }
    if (arg.startsWith('--source=')) {
      const v = arg.slice('--source='.length);
      if (!IMAGE_SOURCES.includes(v)) out.errors.push(`invalid --source: ${v} (expected ${IMAGE_SOURCES.join('|')})`);
      else out.source = v;
      continue;
    }
    if (arg.startsWith('--image-tag=')) {
      const v = arg.slice('--image-tag='.length);
      const err = isImageTag(v);
      if (err) out.errors.push(`--image-tag: ${err}`);
      else out.imageTag = v;
      continue;
    }
    if (arg.startsWith('--image-prefix=')) {
      const v = arg.slice('--image-prefix='.length);
      const err = isImagePrefix(v);
      if (err) out.errors.push(`--image-prefix: ${err}`);
      else out.imagePrefix = v;
      continue;
    }
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