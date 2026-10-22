// scripts/installer/lib/plan.mjs
// Build the .installer-plan.json object consumed by install.sh.

import { resolveTopology } from './topology.mjs';

export function buildPlan({ topology, scale, source, imageTag, imagePrefix, envFilesWritten, externalDb, dbHost }) {
  const resolved = resolveTopology(topology, scale);
  const imageSource = source === 'build' ? 'build' : 'ghcr';
  // Empty overlayFile = nothing to pull (the db host only runs the upstream
  // Postgres image); install.sh must not append an empty `-f`.
  const overlayFile = imageSource === 'ghcr' ? resolved.ghcrOverlay : '';
  return {
    composeFile: resolved.composeFile,
    overlayFile,
    role: resolved.role,
    imageSource,
    // Legacy field: compose up gets --build only in build mode.
    build: imageSource === 'build',
    // Echo the pinned refs for logging; compose reads them from the env files.
    imageTag: imageTag ?? '',
    imagePrefix: imagePrefix ?? '',
    scaleTransfer: topology === 'scale' ? resolved.scale : null,
    needCerts: resolved.needCerts,
    // Per-role env file. mono/scale read the auto-loaded ./.env, so bash passes
    // no --env-file for them.
    envFile: topology === 'mono' || topology === 'scale' ? '' : resolved.envFiles[0],
    // core only: Postgres lives on a db-only host, so bash/user must add
    // -f docker-compose.core.extdb.yml (the local container is profile-gated).
    externalDb: Boolean(externalDb),
    dbHost: dbHost ?? '',
    envFilesWritten: envFilesWritten ?? [],
  };
}