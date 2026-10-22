// scripts/installer/lib/env-schema.mjs
// Source of truth for per-topology env fields + validators.

export const isRequired = (v) => (v && v.length > 0 ? null : 'required');
export const isExact32 = (v) => (v && v.length === 32 ? null : 'must be exactly 32 characters');
export const isNumeric = (v) => (/^\d+$/.test(v) ? null : 'must be numeric');
export const isPositiveInt = (v) => (/^\d+$/.test(v) && Number(v) >= 1 ? null : 'must be an integer >= 1');
export const isIpv4 = (v) => {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(v || '');
  if (!m) return 'must be a valid IPv4 address';
  if (m.slice(1).some((o) => Number(o) > 255)) return 'must be a valid IPv4 address';
  return null;
};
// Bare filename — SSL_CERT_FILE/SSL_KEY_FILE name a file inside ./nginx/ssl and
// flow into an nginx ssl_certificate path. Positive charset (alnum . _ -) so no
// path separator, space, or nginx-config metachar can slip through. Empty is
// allowed so the optional field falls back to compose defaults (cert.pem/key.pem).
export const isFilename = (v) => {
  if (!v) return null;
  return /^[A-Za-z0-9._-]+$/.test(v) ? null : 'must be a bare filename (letters, digits, . _ -)';
};
// Hostname for TRANSFER_DOMAIN → nginx server_name. Positive charset (host label
// chars + optional :port) so scheme, path, spaces, ';' and newlines can't inject
// a stray nginx directive via server_name.
export const isHostname = (v) => (/^[A-Za-z0-9.-]+(:\d+)?$/.test(v || '') ? null : 'must be a bare hostname (no scheme, path, or spaces)');

// Postgres role / database name — an unquoted SQL identifier. Keep it boring:
// lowercase, no quoting, no shell/URL surprises.
export const isDbIdentifier = (v) =>
  /^[a-z_][a-z0-9_]{0,62}$/.test(v || '') ? null : 'must be a lowercase identifier [a-z_][a-z0-9_]* (max 63 chars)';
// TCP port (DB_PORT on both the db host and the core host).
export const isPort = (v) =>
  (/^\d{1,5}$/.test(v || '') && Number(v) >= 1 && Number(v) <= 65535 ? null : 'must be an integer 1..65535');
// Host a DB host is reachable at — bare hostname or IPv4 (no scheme/path).
export const isDbHost = (v) =>
  /^[A-Za-z0-9.-]+$/.test(v || '') ? null : 'must be a bare hostname or IPv4 (no scheme, path, or spaces)';
// Password embedded in DATABASE_URL: anything without whitespace is allowed —
// deriveValues percent-encodes the rest.
export const isDbPassword = (v) => (/\s/.test(v || '') ? 'must not contain whitespace' : null);

const req = (validate) => (v) => isRequired(v) ?? (validate ? validate(v) : null);

// Deploy-image knobs consumed by the docker-compose*.ghcr.yml overlays. Both
// optional: blank keeps the overlay defaults (latest / ghcr.io/realldz/tele-drive).
export const isImageTag = (v) =>
  /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(v || '')
    ? null
    : 'must be a valid image tag (letters, digits, . _ -)';
// ─── CDN data-plane cache (docs/cdn-cache/README.md) ─────────────────────────
// These ENV values are seeded ONCE into SystemSetting at backend-core boot;
// the Go data plane reads them over gRPC from the same table. Blank = default.
const CDN_CACHE_MODES = ['disabled', 'revalidate', 'full'];
const CDN_PUBLIC_S3_MODES = ['inherit', ...CDN_CACHE_MODES];
export const isCdnPublicS3Mode = (v) =>
  (CDN_PUBLIC_S3_MODES.includes(v) ? null : 'must be one of: inherit | disabled | revalidate | full');
export const isCdnMode = (v) =>
  (CDN_CACHE_MODES.includes(v) ? null : 'must be one of: disabled | revalidate | full');
export const isCdnTtl = (v) => {
  const n = Number(v);
  return Number.isInteger(n) && n >= 30 && n <= 604800 ? null : 'must be an integer 30..604800';
};
export const isCdnWindow = (v) => {
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 && n <= 86400 ? null : 'must be an integer 0..86400';
};
// Purge (NestJS core process.env only).
export const isPurgeProvider = (v) =>
  (['none', 'cloudflare'].includes(v) ? null : 'must be one of: none | cloudflare');
export const isZoneId = (v) =>
  (/^[0-9a-fA-F]{32}$/.test(v) ? null : 'must be the 32-hex-char Cloudflare zone ID');
export const isOriginUrl = (v) =>
  (/^https?:\/\/[A-Za-z0-9.-]+(:\d+)?$/.test(v || '') ? null : 'must be an http(s)://origin with no path');

export const isImagePrefix = (v) =>
  /^[a-z0-9][a-z0-9./_-]*$/.test(v || '')
    ? null
    : 'must be a lowercase registry path (registry/owner/repo)';

const IMAGE_FIELDS = (file) => [
  { key: 'TELE_DRIVE_IMAGE_TAG', file, prompt: 'Image tag to deploy (blank = latest; e.g. sha-1a2b3c4)', validate: isImageTag, required: false },
  { key: 'TELE_DRIVE_IMAGE_PREFIX', file, prompt: 'Image registry prefix (blank = ghcr.io/realldz/tele-drive)', validate: isImagePrefix, required: false },
];

// CDN data-plane cache (seeded into SystemSetting at core boot) + purge.
// Optional everywhere: blank keeps the previous value already in the file,
// or leaves the key unset (= in-code defaults). Cache knobs only matter on
// hosts that boot a NestJS core/mono process; the Go host reads over gRPC.
const CDN_CACHE = (file) => [
  { key: 'CDN_CACHE_MODE', file, prompt: 'Data-plane CDN cache mode (blank = disabled; disabled|revalidate|full)', validate: isCdnMode, required: false },
  { key: 'CDN_CACHE_TTL_SECONDS', file, prompt: 'CDN cache TTL seconds for full mode (blank = default 3600)', validate: isCdnTtl, required: false },
  { key: 'CDN_CACHE_WINDOW_SECONDS', file, prompt: 'Token-exp quantization window seconds (blank = off; recommend 300 when caching)', validate: isCdnWindow, required: false },
  { key: 'CDN_CACHE_MODE_PUBLIC_S3', file, prompt: 'Public S3 route cache mode override (blank = inherit CDN_CACHE_MODE)', validate: isCdnPublicS3Mode, required: false },
];
const CDN_PURGE = (file) => [
  { key: 'CDN_PURGE_PROVIDER', file, prompt: 'CDN purge provider (blank = none; none|cloudflare)', validate: isPurgeProvider, required: false },
  { key: 'CLOUDFLARE_API_TOKEN', file, prompt: 'Cloudflare API token with Zone.Cache Purge (blank = unused)', validate: null, required: false, secret: true },
  { key: 'CDN_CACHE_PURGE_ZONE', file, prompt: 'Cloudflare zone ID 32-hex (blank = unused)', validate: isZoneId, required: false },
  { key: 'CDN_CACHE_PURGE_BASE', file, prompt: 'Data-plane origin for purge URLs (blank = PUBLIC_TRANSFER_URL; https://host[:port])', validate: isOriginUrl, required: false },
];

// Shared backend/.env fields (all topologies boot the NestJS backend).
const BACKEND_FIELDS = [
  { key: 'DATABASE_URL', file: 'backend/.env', prompt: 'Postgres connection URL', validate: req(), required: true },
  { key: 'TELEGRAM_BOT_TOKEN', file: 'backend/.env', prompt: 'Telegram bot token', validate: req(), required: true, secret: true },
  { key: 'TELEGRAM_CHAT_ID', file: 'backend/.env', prompt: 'Telegram chat ID', validate: req(), required: true },
  { key: 'JWT_SECRET', file: 'backend/.env', prompt: 'JWT signing secret', validate: req(), required: true, secret: true },
  { key: 'MASTER_SECRET', file: 'backend/.env', prompt: 'Master secret (exactly 32 chars)', validate: req(isExact32), required: true, secret: true },
];

// Telegram Local Bot API app credentials (root/.env-family fields).
const TELEGRAM_APP = (file) => [
  { key: 'TELEGRAM_API_ID', file, prompt: 'Telegram API ID (numeric)', validate: req(isNumeric), required: true },
  { key: 'TELEGRAM_API_HASH', file, prompt: 'Telegram API hash', validate: req(), required: true, secret: true },
];

// Postgres credentials. On the db-only host (.env.db) they create the role +
// database; on a core host that points at it (.env.core) they are the input
// DATABASE_URL is derived from (see deriveValues). Blank password = generated.
const POSTGRES = (file) => [
  { key: 'POSTGRES_USER', file, prompt: 'Postgres role (blank = tele_drive)', validate: isDbIdentifier, required: false },
  { key: 'POSTGRES_DB', file, prompt: 'Postgres database (blank = tele_drive)', validate: isDbIdentifier, required: false },
  { key: 'POSTGRES_PASSWORD', file, prompt: 'Postgres password (auto-generated if blank)', validate: isDbPassword, required: false, secret: true },
];

const REDIS = (file) => ({
  key: 'REDIS_PASSWORD', file, prompt: 'Redis password (auto-generated if blank)', validate: null, required: true, secret: true,
});

const SCHEMA = {
  mono: [
    ...TELEGRAM_APP('.env'),
    REDIS('.env'),
    ...IMAGE_FIELDS('.env'),
    ...BACKEND_FIELDS,
    ...CDN_CACHE('backend/.env'),
    ...CDN_PURGE('backend/.env'),
  ],
  scale: [
    ...TELEGRAM_APP('.env'),
    REDIS('.env'),
    ...IMAGE_FIELDS('.env'),
    ...BACKEND_FIELDS,
    ...CDN_CACHE('backend/.env'),
    ...CDN_PURGE('backend/.env'),
  ],
  core: [
    { key: 'GO_HOST', file: '.env.core', prompt: 'Go data-plane host (name or IP reachable from core)', validate: req(), required: true },
    { key: 'CORE_PRIVATE_IP', file: '.env.core', prompt: 'Core private IP (bind address for Redis + gRPC)', validate: req(isIpv4), required: true },
    { key: 'UPLOAD_BUFFER_NFS', file: '.env.core', prompt: 'Shared upload buffer path (NFS mount)', validate: req(), required: true },
    // External DB (db-only host). Blank DB_HOST keeps the local Postgres
    // container in docker-compose.core.yml; set it when Postgres runs on
    // docker-compose.db.yml, and deploy core with
    // -f docker-compose.core.extdb.yml so the local container never starts.
    { key: 'DB_HOST', file: '.env.core', prompt: 'Postgres host reachable from this core (blank = local container)', validate: isDbHost, required: false },
    { key: 'DB_PORT', file: '.env.core', prompt: 'Postgres port on DB_HOST (blank = 5432)', validate: isPort, required: false },
    ...POSTGRES('.env.core'),
    { key: 'PUBLIC_TRANSFER_URL', file: 'backend/.env', prompt: 'Dedicated transfer origin (abs. data-plane URLs + frontend runtime config; blank = same origin)', validate: isOriginUrl, required: false },
    REDIS('.env.core'),
    ...IMAGE_FIELDS('.env.core'),
    ...BACKEND_FIELDS,
    ...CDN_CACHE('backend/.env'),
    ...CDN_PURGE('backend/.env'),
  ],
  go: [
    { key: 'CORE_HOST', file: '.env.transfer', prompt: 'Core control-plane host (name or IP)', validate: req(), required: true },
    { key: 'GO_PRIVATE_IP', file: '.env.transfer', prompt: 'Go private IP (bind address)', validate: req(isIpv4), required: true },
    { key: 'UPLOAD_BUFFER_NFS', file: '.env.transfer', prompt: 'Shared upload buffer path (NFS mount)', validate: req(), required: true },
    { key: 'TRANSFER_DOMAIN', file: '.env.transfer', prompt: 'Public transfer domain (e.g. dl.example.com)', validate: req(isHostname), required: true },
    { key: 'SSL_CERT_FILE', file: '.env.transfer', prompt: 'TLS cert filename in ./nginx/ssl (blank = self-signed)', validate: isFilename, required: false },
    { key: 'SSL_KEY_FILE', file: '.env.transfer', prompt: 'TLS key filename in ./nginx/ssl (blank = self-signed)', validate: isFilename, required: false },
    REDIS('.env.transfer'),
    ...TELEGRAM_APP('.env.transfer'),
    ...IMAGE_FIELDS('.env.transfer'),
    ...BACKEND_FIELDS,
  ],
  // Database-only host: ONE Postgres container. No backend, no Redis, no gRPC
  // certs (see docker-compose.db.yml + .env.db.example).
  db: [
    { key: 'DB_PRIVATE_IP', file: '.env.db', prompt: 'Private IP THIS db host publishes Postgres on', validate: req(isIpv4), required: true },
    { key: 'DB_PORT', file: '.env.db', prompt: 'Host port for Postgres (blank = 5432)', validate: isPort, required: false },
    ...POSTGRES('.env.db'),
  ],
};

export function fieldsFor(topology) {
  const fields = SCHEMA[topology];
  if (!fields) throw new Error(`unknown topology: ${topology}`);
  return fields;
}

// Values that are COMPUTED rather than prompted, written alongside the prompted
// ones. Only external-DB core hosts produce anything today: compose interpolates
// DATABASE_URL from .env.core (docker-compose.core.yml), so the wizard must
// materialise it from DB_HOST + POSTGRES_*, or the control plane would keep
// pointing at the local container that docker-compose.core.extdb.yml hides.
export function deriveValues(topology, values) {
  const out = [];
  if (topology === 'core' && values.DB_HOST) {
    const user = values.POSTGRES_USER || 'tele_drive';
    const pass = values.POSTGRES_PASSWORD || '';
    const db = values.POSTGRES_DB || 'tele_drive';
    const port = values.DB_PORT || '5432';
    // validateValues already failed the run when DB_HOST is set without a
    // password; never write a half-built URL if that path is ever skipped.
    if (!pass) return out;
    const url = `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${values.DB_HOST}:${port}/${encodeURIComponent(db)}`;
    out.push({ key: 'DATABASE_URL', file: '.env.core', value: url });
  }
  return out;
}

export function validateValues(topology, values) {
  const errors = [];
  for (const f of fieldsFor(topology)) {
    const v = values[f.key];
    if (v === undefined || v === '') {
      // REDIS_PASSWORD is allowed empty here — secrets.mjs fills it before write.
      // DATABASE_URL is COMPUTED by deriveValues on an external-DB core host, so
      // an empty one there is expected input, not a missing field.
      const derived = f.key === 'DATABASE_URL' && topology === 'core' && (values.DB_HOST ?? '') !== '';
      if (f.required && !derived && f.key !== 'REDIS_PASSWORD') errors.push(`${f.key}: required`);
      continue;
    }
    if (f.validate) {
      const err = f.validate(v);
      if (err) errors.push(`${f.key}: ${err}`);
    }
  }

  // Cross-field: an external DB is only usable when the password that created
  // its role is known here too — DATABASE_URL is rebuilt from it (deriveValues).
  // The db topology itself may leave it blank (secrets.mjs generates one).
  if (topology === 'core' && (values.DB_HOST ?? '') !== '' && (values.POSTGRES_PASSWORD ?? '') === '') {
    errors.push('POSTGRES_PASSWORD: required when DB_HOST is set (use the password the db host generated)');
  }

  return errors;
}
