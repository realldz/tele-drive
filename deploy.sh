#!/usr/bin/env bash
# Idempotent single-host production deploy/update for tele-drive.
#
# Safe to run repeatedly: it only CREATES missing prerequisites (REDIS_PASSWORD,
# gRPC mTLS certs) and never overwrites existing ones, then rebuilds + restarts
# the stack. Use it after `git pull` to apply new commits.
#
#   Usage:  ./deploy.sh            # build + up the full stack
#           ./deploy.sh --no-build # restart without rebuilding images
#
# Prerequisites it guards (added by recent commits, would otherwise break up -d):
#   - REDIS_PASSWORD in .env   (Redis now runs --requirepass; no default)
#   - certs/grpc/*             (NestJS <-> Go gRPC now requires mutual TLS)
set -euo pipefail
cd "$(dirname "$0")"

COMPOSE_FILE="docker-compose.yml"
ENV_FILE=".env"
BACKEND_ENV="backend/.env"
CERT_DIR="certs/grpc"
BUILD=1
[ "${1:-}" = "--no-build" ] && BUILD=0

log() { printf '\033[1;34m[deploy]\033[0m %s\n' "$1"; }
die() { printf '\033[1;31m[deploy] ERROR:\033[0m %s\n' "$1" >&2; exit 1; }

# ─── 0. Sanity: required env files must exist (we never invent secrets) ──────
[ -f "$ENV_FILE" ] || die "$ENV_FILE missing — copy .env.example and fill TELEGRAM_API_ID/HASH."
[ -f "$BACKEND_ENV" ] || die "$BACKEND_ENV missing — copy backend/.env.example and fill bot token / secrets."

# ─── 1. Ensure REDIS_PASSWORD exists in .env (commit 164c604) ────────────────
# Redis runs with --requirepass ${REDIS_PASSWORD} and both backends connect via
# redis://:${REDIS_PASSWORD}@redis:6379. Missing -> WRONGPASS -> backends crash.
if grep -qE '^REDIS_PASSWORD=.+' "$ENV_FILE"; then
  log "REDIS_PASSWORD already set in $ENV_FILE — leaving it untouched."
else
  log "REDIS_PASSWORD missing — generating a strong random value into $ENV_FILE."
  # Alphanumeric only: avoids URL-special chars that would break the REDIS_URL.
  PW="$(openssl rand -base64 48 | tr -dc 'a-zA-Z0-9' | head -c 40)"
  [ -n "$PW" ] || die "failed to generate REDIS_PASSWORD (openssl missing?)."
  printf '\nREDIS_PASSWORD=%s\n' "$PW" >> "$ENV_FILE"
fi

# ─── 2. Ensure gRPC mTLS certs exist (commit 42bed82) ────────────────────────
# Compose mounts ./certs/grpc and points GRPC_TLS_CERT/KEY/CA at it. certs/ is
# git-ignored, so a fresh pull has none — backends fail to load TLS material.
# gen-grpc-certs.sh reuses an existing CA, so re-running never rotates live certs.
if [ -f "$CERT_DIR/ca.crt" ] \
  && [ -f "$CERT_DIR/backend-core.crt" ] && [ -f "$CERT_DIR/backend-core.key" ] \
  && [ -f "$CERT_DIR/backend-transfer.crt" ] && [ -f "$CERT_DIR/backend-transfer.key" ]; then
  log "gRPC certs present in $CERT_DIR — leaving them untouched."
else
  log "gRPC certs missing/incomplete — generating into $CERT_DIR."
  [ -x scripts/gen-grpc-certs.sh ] || chmod +x scripts/gen-grpc-certs.sh
  ./scripts/gen-grpc-certs.sh
fi

# ─── 3. Build + start the stack ──────────────────────────────────────────────
# --build is required: `up -d` alone reuses cached images and would run OLD code
# after a git pull. Use --no-build only for a config-only restart.
if [ "$BUILD" -eq 1 ]; then
  log "Building images + starting stack (docker compose up -d --build)..."
  docker compose -f "$COMPOSE_FILE" up -d --build
else
  log "Restarting stack without rebuild (docker compose up -d)..."
  docker compose -f "$COMPOSE_FILE" up -d
fi

# ─── 4. Post-deploy verification ─────────────────────────────────────────────
# Query health via `compose ps` so we don't hardcode the container replica suffix
# (project-service-N). A single-instance deploy reports one line per service.
log "Waiting for backend-core + backend-transfer to report healthy..."
ok=0
for i in $(seq 1 30); do
  core=$(docker compose -f "$COMPOSE_FILE" ps --format '{{.Service}} {{.Health}}' 2>/dev/null | grep '^backend-core ' | awk '{print $2}' | head -1)
  tr=$(docker compose -f "$COMPOSE_FILE" ps --format '{{.Service}} {{.Health}}' 2>/dev/null | grep '^backend-transfer ' | awk '{print $2}' | head -1)
  if [ "$core" = "healthy" ] && [ "$tr" = "healthy" ]; then ok=1; break; fi
  sleep 4
done

if [ "$ok" -eq 1 ]; then
  log "Stack healthy. Checking for auth/TLS errors in recent logs..."
else
  log "WARNING: backends not healthy after ~2min (core=$core transfer=$tr). Dumping clues:"
fi

# Surface the two failure modes this script guards against, if they slipped through.
if docker compose -f "$COMPOSE_FILE" logs --since 3m backend-core backend-transfer 2>/dev/null \
   | grep -iE "wrongpass|noauth|cert|tls|can't resolve" | head -10; then
  :
fi

log "Done. 'docker compose -f $COMPOSE_FILE ps' for status; app on https://localhost"
[ "$ok" -eq 1 ] || die "deploy completed but health check failed — inspect logs above."
