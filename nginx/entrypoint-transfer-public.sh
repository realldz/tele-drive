#!/bin/sh
set -e

# Public data-plane nginx entrypoint (HOST-GO). Renders
# nginx-transfer-public.conf.template via envsubst, self-signs the transfer-domain
# and dummy certs if missing, then runs nginx. Only ${TRANSFER_DOMAIN},
# ${SSL_CERT_FILE}, ${SSL_KEY_FILE} are substituted — nginx runtime vars
# ($host, $request_id, $transfer_upstream, ...) are left intact.

SSL_CERT_FILE="${SSL_CERT_FILE:-cert.pem}"
SSL_KEY_FILE="${SSL_KEY_FILE:-key.pem}"
CERT_PATH="/etc/nginx/ssl/${SSL_CERT_FILE}"
KEY_PATH="/etc/nginx/ssl/${SSL_KEY_FILE}"

# ─── Generate dummy cert for default_server (404 catch-all) ─────────
if [ ! -f /etc/nginx/ssl/dummy.crt ]; then
  echo "[nginx-transfer] Generating dummy self-signed cert..."
  openssl req -x509 -newkey rsa:2048 -keyout /etc/nginx/ssl/dummy.key \
    -out /etc/nginx/ssl/dummy.crt -days 3650 -nodes -subj "/CN=localhost" 2>/dev/null
fi

# ─── Generate self-signed cert for $TRANSFER_DOMAIN if missing ───────
# Production should mount a real cert (Let's Encrypt / CA) for the transfer
# domain at these paths; the self-signed fallback keeps dev/first-boot working.
if [ ! -f "${CERT_PATH}" ] || [ ! -f "${KEY_PATH}" ]; then
  DOMAIN="${TRANSFER_DOMAIN:-localhost}"
  echo "[nginx-transfer] No SSL cert found for '${DOMAIN}'. Generating self-signed cert..."
  openssl req -x509 -newkey rsa:2048 -keyout "${KEY_PATH}" \
    -out "${CERT_PATH}" -days 3650 -nodes -subj "/CN=${DOMAIN}" 2>/dev/null
  echo "[nginx-transfer] Self-signed cert created at ${CERT_PATH}"
fi

# ─── Apply envsubst to template ──────────────────────────────────────
echo "[nginx-transfer] Rendering public data-plane config from template..."
export TRANSFER_DOMAIN="${TRANSFER_DOMAIN:-_}"
export SSL_CERT_FILE="${SSL_CERT_FILE}"
export SSL_KEY_FILE="${SSL_KEY_FILE}"
envsubst '${TRANSFER_DOMAIN} ${SSL_CERT_FILE} ${SSL_KEY_FILE}' \
  < /etc/nginx/conf.d/nginx.conf.template \
  > /etc/nginx/conf.d/default.conf

# ─── Start nginx ─────────────────────────────────────────────────────
echo "[nginx-transfer] Starting nginx..."
exec nginx -g 'daemon off;'
