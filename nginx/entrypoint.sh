#!/bin/sh
set -e

SSL_CERT_FILE="${SSL_CERT_FILE:-cert.pem}"
SSL_KEY_FILE="${SSL_KEY_FILE:-key.pem}"
CERT_PATH="/etc/nginx/ssl/${SSL_CERT_FILE}"
KEY_PATH="/etc/nginx/ssl/${SSL_KEY_FILE}"

# ─── Generate dummy cert for default_server (404 catch-all) ─────────
if [ ! -f /etc/nginx/ssl/dummy.crt ]; then
  echo "[nginx] Generating dummy self-signed cert..."
  openssl req -x509 -newkey rsa:2048 -keyout /etc/nginx/ssl/dummy.key \
    -out /etc/nginx/ssl/dummy.crt -days 3650 -nodes -subj "/CN=localhost" 2>/dev/null
fi

# ─── Generate self-signed cert for $APP_DOMAIN if missing ────────────
if [ ! -f "${CERT_PATH}" ] || [ ! -f "${KEY_PATH}" ]; then
  DOMAIN="${APP_DOMAIN:-localhost}"
  echo "[nginx] No SSL cert found for '${DOMAIN}'. Generating self-signed cert..."
  openssl req -x509 -newkey rsa:2048 -keyout "${KEY_PATH}" \
    -out "${CERT_PATH}" -days 3650 -nodes -subj "/CN=${DOMAIN}" 2>/dev/null
  echo "[nginx] Self-signed cert created at ${CERT_PATH}"
fi

# ─── Wait for upstream services ──────────────────────────────────────
echo "[nginx] Waiting for backend service..."
MAX_ATTEMPTS=30
ATTEMPT=0
while [ $ATTEMPT -lt $MAX_ATTEMPTS ]; do
  if getent hosts backend >/dev/null 2>&1; then
    echo "[nginx] Backend service is reachable"
    break
  fi
  ATTEMPT=$((ATTEMPT + 1))
  sleep 1
done

if [ $ATTEMPT -eq $MAX_ATTEMPTS ]; then
  echo "[nginx] Warning: backend service not reachable after ${MAX_ATTEMPTS}s. Starting anyway..."
fi

# ─── Apply envsubst to template ──────────────────────────────────────
echo "[nginx] Rendering nginx.conf from template..."
export APP_DOMAIN="${APP_DOMAIN:-_}"
export SSL_CERT_FILE="${SSL_CERT_FILE}"
export SSL_KEY_FILE="${SSL_KEY_FILE}"
envsubst '${APP_DOMAIN} ${SSL_CERT_FILE} ${SSL_KEY_FILE}' \
  < /etc/nginx/conf.d/nginx.conf.template \
  > /etc/nginx/conf.d/default.conf

# ─── Start nginx ─────────────────────────────────────────────────────
echo "[nginx] Starting nginx..."
exec nginx -g 'daemon off;'
