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
# Clean up the scratch plan on ANY exit (including set -e failures at compose-up
# or cert-gen), so it never leaks. Explicit rm calls below are now redundant but
# harmless; keeping the trap makes every exit path uniform.
trap 'rm -f "$PLAN_FILE"' EXIT

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

# The CORE host is the control plane and the CA origin: it must run first, mint
# the shared gRPC CA (gen-grpc-certs.sh), then its certs are copied to the go
# host out-of-band. A single-host script cannot orchestrate that ordering, so
# core stays configure-and-hand-off (print exact deploy steps, do not deploy).
# go auto-deploys further below — it only VERIFIES the copied certs, never mints.
if [ "$ROLE" = "core" ]; then
  ENV_FILE=".env.core"
  BUILD_FLAG=""
  [ "$BUILD" = "true" ] && BUILD_FLAG=" --build"
  log "Core host config written. install.sh does NOT auto-deploy the core control plane."
  printf '\n  Complete the core deploy manually on THIS host:\n\n'
  printf '  1. Mint the shared gRPC CA on this CORE host only:\n'
  printf '       ./scripts/gen-grpc-certs.sh\n'
  printf '  2. Copy certs/grpc/{ca.crt,backend-transfer.crt,backend-transfer.key} to the go host.\n'
  printf '  3. REDIS_PASSWORD in %s must match the value on the go host.\n' "$ENV_FILE"
  printf '  4. Bring up the control plane:\n'
  printf '       docker compose --env-file %s -f %s up -d%s\n\n' "$ENV_FILE" "$COMPOSE_FILE" "$BUILD_FLAG"
  rm -f "$PLAN_FILE"
  exit 0
fi

# 4. Certs.
# go host: VERIFY ONLY — never mint. Its certs are copied from the core host so
# both share one CA. Running gen-grpc-certs.sh here would mint a divergent CA and
# break mTLS (downloads/streams 500). It also needs no backend-core.* keypair.
# mono/scale: idempotent gen — regenerate only if incomplete.
certs_complete() {
  [ -f "$CERT_DIR/ca.crt" ] \
    && [ -f "$CERT_DIR/backend-core.crt" ] && [ -f "$CERT_DIR/backend-core.key" ] \
    && [ -f "$CERT_DIR/backend-transfer.crt" ] && [ -f "$CERT_DIR/backend-transfer.key" ]
}
# ponytail: verifies certs EXIST and are non-empty (-s), not that they chain to
# the core CA. A divergent CA minted here previously would still pass. Full
# detection needs a known-good CA fingerprint — upgrade to `openssl verify
# -CAfile` against a pinned fingerprint if divergent-CA drift becomes a problem.
if [ "$ROLE" = "go" ]; then
  if [ -s "$CERT_DIR/ca.crt" ] && [ -s "$CERT_DIR/backend-transfer.crt" ] && [ -s "$CERT_DIR/backend-transfer.key" ]; then
    log "gRPC certs present — reusing (copied from core host)."
  else
    err "gRPC certs missing on this go host."
    printf '  Copy certs/grpc/{ca.crt,backend-transfer.crt,backend-transfer.key} from the CORE host.\n' >&2
    printf '  Do NOT run gen-grpc-certs.sh here — it mints a divergent CA and mTLS will fail.\n' >&2
    rm -f "$PLAN_FILE"
    exit 1
  fi
elif [ "$NEED_CERTS" = "true" ]; then
  if certs_complete; then
    log "gRPC certs present — reusing."
  else
    log "Generating gRPC certs..."
    ./scripts/gen-grpc-certs.sh
  fi
fi

# 5. Bring the stack up. go must load .env.transfer explicitly (compose only
# auto-loads ./.env); the --env-file global flag precedes the up subcommand.
ENV_FILE_ARGS=()
[ "$ROLE" = "go" ] && ENV_FILE_ARGS=(--env-file .env.transfer)
# ${arr[@]+"${arr[@]}"} expands to nothing when the array is empty (mono/scale),
# instead of a spurious "" arg — and stays safe under `set -u` on bash 3.2+.
UP_ARGS=(${ENV_FILE_ARGS[@]+"${ENV_FILE_ARGS[@]}"} -f "$COMPOSE_FILE" up -d)
[ "$BUILD" = "true" ] && UP_ARGS+=(--build)
if [ -n "$SCALE_TRANSFER" ]; then
  UP_ARGS+=(--scale "backend-transfer=$SCALE_TRANSFER")
fi
log "docker compose ${UP_ARGS[*]}"
docker compose "${UP_ARGS[@]}"

# 6. Health check ALL replicas (not head -1). Role-aware: the go host has no
# backend-core, so waiting on it there would hang until timeout. go waits only
# on backend-transfer; mono/scale wait on backend-core + every transfer replica.
log "Waiting for services to become healthy..."
HEALTHY=0
for _ in $(seq 1 30); do
  # One line per service replica: "<service> <health>"
  STATUS="$(docker compose ${ENV_FILE_ARGS[@]+"${ENV_FILE_ARGS[@]}"} -f "$COMPOSE_FILE" ps --format '{{.Service}} {{.Health}}' 2>/dev/null || true)"
  BT_TOTAL="$(printf '%s\n' "$STATUS" | awk '$1=="backend-transfer"' | wc -l | tr -d ' ')"
  BT_OK="$(printf '%s\n' "$STATUS" | awk '$1=="backend-transfer" && $2=="healthy"' | wc -l | tr -d ' ')"
  if [ "$ROLE" = "go" ]; then
    # No backend-core on this host — backend-transfer healthy is the signal.
    if [ "$BT_TOTAL" -ge 1 ] && [ "$BT_OK" -eq "$BT_TOTAL" ]; then
      HEALTHY=1
      break
    fi
  else
    CORE_OK="$(printf '%s\n' "$STATUS" | awk '$1=="backend-core" && $2=="healthy"' | wc -l | tr -d ' ')"
    if [ "$CORE_OK" -ge 1 ] && [ "$BT_TOTAL" -ge 1 ] && [ "$BT_OK" -eq "$BT_TOTAL" ]; then
      HEALTHY=1
      break
    fi
  fi
  sleep 4
done

if [ "$HEALTHY" = "1" ]; then
  log "All services healthy."
else
  err "Services did not become healthy in time. Recent diagnostic logs:"
  docker compose ${ENV_FILE_ARGS[@]+"${ENV_FILE_ARGS[@]}"} -f "$COMPOSE_FILE" logs --tail 200 2>/dev/null \
    | grep -iE "wrongpass|noauth|cert|tls|can't resolve|permission denied" | tail -20 || true
  rm -f "$PLAN_FILE"
  exit 1
fi

# 7. Cleanup scratch plan.
rm -f "$PLAN_FILE"
log "Done."
