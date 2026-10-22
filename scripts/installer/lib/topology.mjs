// scripts/installer/lib/topology.mjs
// Map a topology to its compose file, scale count, env files, cert needs, and role.

export const TOPOLOGIES = ['mono', 'scale', 'core', 'go', 'db'];

// ghcrOverlay: the pull-only overlay this topology uses when the plan's image
// source is "ghcr" (deploy from the images CI publishes instead of building).
// Empty string = nothing to pull (the db host only runs the upstream Postgres
// image, which CI never publishes).
// needCerts: whether bash must mint/verify the gRPC mTLS material. Only the
// NestJS<->Go pair speaks gRPC, so the db host never needs certs.
const MAP = {
  mono: { composeFile: 'docker-compose.yml', ghcrOverlay: 'docker-compose.ghcr.yml', role: 'mono', envFiles: ['.env'], needCerts: true },
  scale: { composeFile: 'docker-compose.yml', ghcrOverlay: 'docker-compose.ghcr.yml', role: 'mono', envFiles: ['.env'], needCerts: true },
  core: { composeFile: 'docker-compose.core.yml', ghcrOverlay: 'docker-compose.core.ghcr.yml', role: 'core', envFiles: ['.env.core'], needCerts: true },
  go: { composeFile: 'docker-compose.transfer.yml', ghcrOverlay: 'docker-compose.transfer.ghcr.yml', role: 'go', envFiles: ['.env.transfer'], needCerts: false },
  db: { composeFile: 'docker-compose.db.yml', ghcrOverlay: '', role: 'db', envFiles: ['.env.db'], needCerts: false },
};

export function resolveTopology(topology, scale) {
  const base = MAP[topology];
  if (!base) throw new Error(`unknown topology: ${topology}`);
  return {
    composeFile: base.composeFile,
    ghcrOverlay: base.ghcrOverlay,
    role: base.role,
    envFiles: base.envFiles,
    needCerts: base.needCerts,
    scale: topology === 'scale' ? (scale && scale >= 1 ? scale : 1) : 1,
  };
}