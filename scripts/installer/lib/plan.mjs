// scripts/installer/lib/plan.mjs
// Build the .installer-plan.json object consumed by install.sh.

import { resolveTopology } from './topology.mjs';

export function buildPlan({ topology, scale, build, envFilesWritten }) {
  const resolved = resolveTopology(topology, scale);
  return {
    composeFile: resolved.composeFile,
    role: resolved.role,
    build: Boolean(build),
    scaleTransfer: topology === 'scale' ? resolved.scale : null,
    needCerts: true,
    envFilesWritten: envFilesWritten ?? [],
  };
}
