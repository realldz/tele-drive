// scripts/installer/lib/env-file.mjs
// Parse/render .env files preserving comments and line order.
// Overwrite only changed values in place; append new keys at the end.

const KV_RE = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/;

// Strip a single matched pair of surrounding quotes (" or ') so a stored
// MASTER_SECRET="…32…" reads back as 32 chars, not 34. Unbalanced or inner
// quotes are left untouched.
function unquote(value) {
  if (value.length >= 2) {
    const q = value[0];
    if ((q === '"' || q === "'") && value[value.length - 1] === q) {
      return value.slice(1, -1);
    }
  }
  return value;
}

export function parseEnv(text) {
  const rawLines = text.length === 0 ? [] : text.replace(/\n$/, '').split('\n');
  const lines = rawLines.map((raw) => {
    const m = raw.match(KV_RE);
    if (m) return { raw, key: m[1], value: unquote(m[2]) };
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
