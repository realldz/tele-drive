// scripts/installer/lib/topology.mjs
// Map a topology to its compose file, scale count, env files, and role.

export const TOPOLOGIES = ['mono', 'scale', 'core', 'go'];

// ghcrOverlay: the pull-only overlay this topology uses when the plan's image
// source is "ghcr" (deploy from the images CI publishes instead of building).
const MAP = {
  mono: { composeFile: 'docker-compose.yml', ghcrOverlay: 'docker-compose.ghcr.yml', role: 'mono', envFiles: ['.env'] },
  scale: { composeFile: 'docker-compose.yml', ghcrOverlay: 'docker-compose.ghcr.yml', role: 'mono', envFiles: ['.env'] },
  core: { composeFile: 'docker-compose.core.yml', ghcrOverlay: 'docker-compose.core.ghcr.yml', role: 'core', envFiles: ['.env.core'] },
  go: { composeFile: 'docker-compose.transfer.yml', ghcrOverlay: 'docker-compose.transfer.ghcr.yml', role: 'go', envFiles: ['.env.transfer'] },
};

export function resolveTopology(topology, scale) {
  const base = MAP[topology];
  if (!base) throw new Error(`unknown topology: ${topology}`);
  return {
    composeFile: base.composeFile,
    ghcrOverlay: base.ghcrOverlay,
    role: base.role,
    envFiles: base.envFiles,
    scale: topology === 'scale' ? (scale && scale >= 1 ? scale : 1) : 1,
  };
}