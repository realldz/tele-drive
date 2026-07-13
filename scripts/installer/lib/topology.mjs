// scripts/installer/lib/topology.mjs
// Map a topology to its compose file, scale count, env files, and role.

export const TOPOLOGIES = ['mono', 'scale', 'core', 'go'];

const MAP = {
  mono: { composeFile: 'docker-compose.yml', role: 'mono', envFiles: ['.env'] },
  scale: { composeFile: 'docker-compose.yml', role: 'mono', envFiles: ['.env'] },
  core: { composeFile: 'docker-compose.core.yml', role: 'core', envFiles: ['.env.core'] },
  go: { composeFile: 'docker-compose.transfer.yml', role: 'go', envFiles: ['.env.transfer'] },
};

export function resolveTopology(topology, scale) {
  const base = MAP[topology];
  if (!base) throw new Error(`unknown topology: ${topology}`);
  return {
    composeFile: base.composeFile,
    role: base.role,
    envFiles: base.envFiles,
    scale: topology === 'scale' ? (scale && scale >= 1 ? scale : 1) : 1,
  };
}
