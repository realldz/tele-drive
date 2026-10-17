// scripts/installer/lib/plan.mjs
// Build the .installer-plan.json object consumed by install.sh.

import { resolveTopology } from './topology.mjs';

export function buildPlan({ topology, scale, source, imageTag, imagePrefix, envFilesWritten }) {
  const resolved = resolveTopology(topology, scale);
  const imageSource = source === 'build' ? 'build' : 'ghcr';
  return {
    composeFile: resolved.composeFile,
    // Set only when deploying prebuilt images; install.sh appends it to -f.
    overlayFile: imageSource === 'ghcr' ? resolved.ghcrOverlay : '',
    role: resolved.role,
    imageSource,
    // Legacy field: compose up gets --build only in build mode.
    build: imageSource === 'build',
    // Echo the pinned refs for logging; compose reads them from the env files.
    imageTag: imageTag ?? '',
    imagePrefix: imagePrefix ?? '',
    scaleTransfer: topology === 'scale' ? resolved.scale : null,
    needCerts: true,
    envFilesWritten: envFilesWritten ?? [],
  };
}