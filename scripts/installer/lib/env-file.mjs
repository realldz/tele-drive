// scripts/installer/lib/env-file.mjs
// Parse/render .env files preserving comments and line order.
// Overwrite only changed values in place; append new keys at the end.

const KV_RE = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/;

export function parseEnv(text) {
  const rawLines = text.length === 0 ? [] : text.replace(/\n$/, '').split('\n');
  const lines = rawLines.map((raw) => {
    const m = raw.match(KV_RE);
    if (m) return { raw, key: m[1], value: m[2] };
    return { raw, key: null, value: null };
  });
  return { lines };
}

export function getValue(parsed, key) {
  for (const line of parsed.lines) {
    if (line.key === key) return line.value;
  }
  return undefined;
}

export function renderEnv(parsed, updates) {
  const applied = new Set();
  const out = parsed.lines.map((line) => {
    if (line.key !== null && Object.prototype.hasOwnProperty.call(updates, line.key)) {
      applied.add(line.key);
      return `${line.key}=${updates[line.key]}`;
    }
    return line.raw;
  });
  for (const [key, value] of Object.entries(updates)) {
    if (!applied.has(key)) out.push(`${key}=${value}`);
  }
  return out.join('\n') + '\n';
}
