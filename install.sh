#!/usr/bin/env bash
# Wizard installer — replaces deploy.sh.
# Host needs only Docker; the Node wizard runs in an ephemeral container.
set -euo pipefail
cd "$(dirname "$0")"

PLAN_FILE=".installer-plan.json"
CERT_DIR="certs/grpc"
NODE_IMAGE="node:22-alpine"

log()  { printf '\n\033[1;34m==>\033[0m %s\n' "$*"; }
err()  { printf '\033[1;31mERROR:\033[0m %s\n' "$*" >&2; }

# 1. Preflight.
command -v docker >/dev/null 2>&1 || { err "docker not found. Install Docker first."; exit 1; }
docker compose version >/dev/null 2>&1 || { err "'docker compose' not available."; exit 1; }

# 2. Run the wizard in a container. TTY only when attached to one.
log "Running configuration wizard..."
TTY_FLAGS=()
[ -t 0 ] && TTY_FLAGS=(-it)
if ! docker run --rm "${TTY_FLAGS[@]}" -v "$PWD":/repo -w /repo "$NODE_IMAGE" \
      node scripts/installer/index.mjs "$@"; then
  err "Wizard aborted; nothing deployed."
  exit 1
fi
[ -f "$PLAN_FILE" ] || { err "wizard produced no plan ($PLAN_FILE missing)."; exit 1; }

# 3. Read plan fields via node (no jq dependency on the host).
read_plan() {
  docker run --rm -v "$PWD":/repo -w /repo "$NODE_IMAGE" \
    node -e "const p=require('/repo/$PLAN_FILE'); process.stdout.write(String(p[process.argv[1]] ?? ''))" "$1"
}
COMPOSE_FILE="$(read_plan composeFile)"
BUILD="$(read_plan build)"
SCALE_TRANSFER="$(read_plan scaleTransfer)"
NEED_CERTS="$(read_plan needCerts)"
ROLE="$(read_plan role)"
log "Plan: compose=$COMPOSE_FILE role=$ROLE build=$BUILD scale=${SCALE_TRANSFER:-none}"

# Multi-host (core/go) needs cross-host coordination a single-host script
# cannot perform: the gRPC CA must be shared across hosts and REDIS_PASSWORD
# must match. Print the exact deploy command + steps and hand off, rather
# than running compose (which would mint a divergent CA and mis-resolve the
# per-role env vars). Only mono/scale are auto-deployed below.
if [ "$ROLE" = "core" ] || [ "$ROLE" = "go" ]; then
  if [ "$ROLE" = "core" ]; then ENV_FILE=".env.core"; else ENV_FILE=".env.transfer"; fi
  BUILD_FLAG=""
  [ "$BUILD" = "true" ] && BUILD_FLAG=" --build"
  log "Multi-host ($ROLE) config written. install.sh does NOT deploy multi-host automatically."
  printf '\n  Complete the multi-host deploy manually on THIS host:\n\n'
  printf '  1. gRPC certs must share one CA across both hosts:\n'
  printf '       - On the CORE host only: ./scripts/gen-grpc-certs.sh\n'
  printf '       - Copy certs/grpc/* from the core host to this host (identical CA + trust).\n'
  printf '  2. REDIS_PASSWORD in %s must match the value on the other host.\n' "$ENV_FILE"
  printf '  3. Bring up the stack:\n'
  printf '       docker compose --env-file %s -f %s up -d%s\n\n' "$ENV_FILE" "$COMPOSE_FILE" "$BUILD_FLAG"
  rm -f "$PLAN_FILE"
  exit 0
fi

# 4. Certs (idempotent — regenerate only if incomplete).
certs_complete() {
  [ -f "$CERT_DIR/ca.crt" ] \
    && [ -f "$CERT_DIR/backend-core.crt" ] && [ -f "$CERT_DIR/backend-core.key" ] \
    && [ -f "$CERT_DIR/backend-transfer.crt" ] && [ -f "$CERT_DIR/backend-transfer.key" ]
}
if [ "$NEED_CERTS" = "true" ]; then
  if certs_complete; then
    log "gRPC certs present — reusing."
  else
    log "Generating gRPC certs..."
    ./scripts/gen-grpc-certs.sh
  fi
fi

# 5. Bring the stack up.
UP_ARGS=(-f "$COMPOSE_FILE" up -d)
[ "$BUILD" = "true" ] && UP_ARGS+=(--build)
if [ -n "$SCALE_TRANSFER" ]; then
  UP_ARGS+=(--scale "backend-transfer=$SCALE_TRANSFER")
fi
log "docker compose ${UP_ARGS[*]}"
docker compose "${UP_ARGS[@]}"

# 6. Health check ALL replicas (not head -1).
log "Waiting for services to become healthy..."
HEALTHY=0
for _ in $(seq 1 30); do
  # One line per service replica: "<service> <health>"
  STATUS="$(docker compose -f "$COMPOSE_FILE" ps --format '{{.Service}} {{.Health}}' 2>/dev/null || true)"
  # backend-core must be healthy; every backend-transfer replica must be healthy.
  CORE_OK="$(printf '%s\n' "$STATUS" | awk '$1=="backend-core" && $2=="healthy"' | wc -l | tr -d ' ')"
  BT_TOTAL="$(printf '%s\n' "$STATUS" | awk '$1=="backend-transfer"' | wc -l | tr -d ' ')"
  BT_OK="$(printf '%s\n' "$STATUS" | awk '$1=="backend-transfer" && $2=="healthy"' | wc -l | tr -d ' ')"
  if [ "$CORE_OK" -ge 1 ] && [ "$BT_TOTAL" -ge 1 ] && [ "$BT_OK" -eq "$BT_TOTAL" ]; then
    HEALTHY=1
    break
  fi
  sleep 4
done

if [ "$HEALTHY" = "1" ]; then
  log "All services healthy."
else
  err "Services did not become healthy in time. Recent diagnostic logs:"
  docker compose -f "$COMPOSE_FILE" logs --tail 200 2>/dev/null \
    | grep -iE "wrongpass|noauth|cert|tls|can't resolve|permission denied" | tail -20 || true
  rm -f "$PLAN_FILE"
  exit 1
fi

# 7. Cleanup scratch plan.
rm -f "$PLAN_FILE"
log "Done."
