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

const req = (validate) => (v) => isRequired(v) ?? (validate ? validate(v) : null);

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

const REDIS = (file) => ({
  key: 'REDIS_PASSWORD', file, prompt: 'Redis password (auto-generated if blank)', validate: null, required: true, secret: true,
});

const SCHEMA = {
  mono: [
    ...TELEGRAM_APP('.env'),
    REDIS('.env'),
    ...BACKEND_FIELDS,
  ],
  scale: [
    ...TELEGRAM_APP('.env'),
    REDIS('.env'),
    ...BACKEND_FIELDS,
  ],
  core: [
    { key: 'GO_HOST', file: '.env.core', prompt: 'Go data-plane host (name or IP reachable from core)', validate: req(), required: true },
    { key: 'CORE_PRIVATE_IP', file: '.env.core', prompt: 'Core private IP (bind address for Redis + gRPC)', validate: req(isIpv4), required: true },
    { key: 'UPLOAD_BUFFER_NFS', file: '.env.core', prompt: 'Shared upload buffer path (NFS mount)', validate: req(), required: true },
    REDIS('.env.core'),
    ...BACKEND_FIELDS,
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
    ...BACKEND_FIELDS,
  ],
};

export function fieldsFor(topology) {
  const fields = SCHEMA[topology];
  if (!fields) throw new Error(`unknown topology: ${topology}`);
  return fields;
}

export function validateValues(topology, values) {
  const errors = [];
  for (const f of fieldsFor(topology)) {
    const v = values[f.key];
    if (v === undefined || v === '') {
      // REDIS_PASSWORD is allowed empty here — secrets.mjs fills it before write.
      if (f.required && f.key !== 'REDIS_PASSWORD') errors.push(`${f.key}: required`);
      continue;
    }
    if (f.validate) {
      const err = f.validate(v);
      if (err) errors.push(`${f.key}: ${err}`);
    }
  }
  return errors;
}
