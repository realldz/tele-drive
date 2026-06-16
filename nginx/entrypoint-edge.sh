#!/bin/sh
set -e

SSL_CERT_FILE="${SSL_CERT_FILE:-cert.pem}"
SSL_KEY_FILE="${SSL_KEY_FILE:-key.pem}"
CERT_PATH="/etc/nginx/ssl/${SSL_CERT_FILE}"
KEY_PATH="/etc/nginx/ssl/${SSL_KEY_FILE}"

# ─── Generate dummy cert for default_server (404 catch-all) ─────────
if [ ! -f /etc/nginx/ssl/dummy.crt ]; then
  echo "[nginx-edge] Generating dummy self-signed cert..."
  openssl req -x509 -newkey rsa:2048 -keyout /etc/nginx/ssl/dummy.key \
    -out /etc/nginx/ssl/dummy.crt -days 3650 -nodes -subj "/CN=localhost" 2>/dev/null
fi

# ─── Generate self-signed cert for $APP_DOMAIN if missing ────────────
if [ ! -f "${CERT_PATH}" ] || [ ! -f "${KEY_PATH}" ]; then
  DOMAIN="${APP_DOMAIN:-localhost}"
  echo "[nginx-edge] No SSL cert found for '${DOMAIN}'. Generating self-signed cert..."
  openssl req -x509 -newkey rsa:2048 -keyout "${KEY_PATH}" \
    -out "${CERT_PATH}" -days 3650 -nodes -subj "/CN=${DOMAIN}" 2>/dev/null
  echo "[nginx-edge] Self-signed cert created at ${CERT_PATH}"
fi

# ─── Expand GO_UPSTREAM into upstream server lines ───────────────────
# GO_UPSTREAM is a comma- and/or space-separated list of Go data-plane targets
# (host:port). The template no longer references it directly; instead the named
# `upstream go_data_plane` block is filled from ${GO_UPSTREAM_SERVERS}, one
# `server <host:port> ...;` line per entry:
#   single entry → plain single-target proxy (unchanged single-host behavior)
#   many entries → nginx round_robins and ejects a host for fail_timeout after
#                  max_fails consecutive errors (passive health checking)
# This is the edge-side horizontal scaling for the data plane.
#
# A missing GO_UPSTREAM is a hard error: an empty upstream block fails nginx -t,
# which is the desired loud failure rather than silently routing data-plane
# traffic nowhere.
if [ -z "${GO_UPSTREAM}" ]; then
  echo "[nginx-edge] FATAL: GO_UPSTREAM is unset — no data-plane target to proxy to." >&2
  exit 1
fi

GO_UPSTREAM_SERVERS=""
# Split on commas and whitespace; emit one server line per non-empty token.
for target in $(echo "${GO_UPSTREAM}" | tr ',' ' '); do
  [ -z "${target}" ] && continue
  GO_UPSTREAM_SERVERS="${GO_UPSTREAM_SERVERS}    server ${target} max_fails=3 fail_timeout=30s;
"
done
echo "[nginx-edge] Go data-plane upstream servers:"
echo "${GO_UPSTREAM_SERVERS}"

# ─── Apply envsubst to template ──────────────────────────────────────
# Substitutes the public-domain/SSL vars PLUS ${GO_UPSTREAM_SERVERS} (the expanded
# upstream server lines). Nginx runtime vars ($host, $request_id, etc.) are NOT in
# the list, so envsubst leaves them intact.
echo "[nginx-edge] Rendering edge config from template..."
export APP_DOMAIN="${APP_DOMAIN:-_}"
export S3_DOMAIN="${S3_DOMAIN:-s3.example.com}"
export SSL_CERT_FILE="${SSL_CERT_FILE}"
export SSL_KEY_FILE="${SSL_KEY_FILE}"
export GO_UPSTREAM_SERVERS
envsubst '${APP_DOMAIN} ${S3_DOMAIN} ${SSL_CERT_FILE} ${SSL_KEY_FILE} ${GO_UPSTREAM_SERVERS}' \
  < /etc/nginx/conf.d/nginx.conf.template \
  > /etc/nginx/conf.d/default.conf

# ─── Start nginx ─────────────────────────────────────────────────────
echo "[nginx-edge] Starting nginx..."
exec nginx -g 'daemon off;'
