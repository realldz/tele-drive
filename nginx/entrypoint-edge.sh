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

# ─── Apply envsubst to template ──────────────────────────────────────
# Same vars as the single-host entrypoint PLUS ${GO_UPSTREAM} — the cross-host
# data-plane target (GO_HOST:3001). If GO_UPSTREAM is unset the rendered config
# would contain an empty proxy_pass and nginx -t would fail, which is the desired
# loud failure rather than silently routing data-plane traffic nowhere.
echo "[nginx-edge] Rendering edge config from template..."
export APP_DOMAIN="${APP_DOMAIN:-_}"
export S3_DOMAIN="${S3_DOMAIN:-s3.example.com}"
export SSL_CERT_FILE="${SSL_CERT_FILE}"
export SSL_KEY_FILE="${SSL_KEY_FILE}"
export GO_UPSTREAM="${GO_UPSTREAM}"
envsubst '${APP_DOMAIN} ${S3_DOMAIN} ${SSL_CERT_FILE} ${SSL_KEY_FILE} ${GO_UPSTREAM}' \
  < /etc/nginx/conf.d/nginx.conf.template \
  > /etc/nginx/conf.d/default.conf

# ─── Start nginx ─────────────────────────────────────────────────────
echo "[nginx-edge] Starting nginx..."
exec nginx -g 'daemon off;'
