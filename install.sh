#!/usr/bin/env bash
# Wizard installer — replaces deploy.sh.
# Host needs only Docker; the Node wizard runs in an ephemeral container.
# Default image mode pulls the prebuilt images CI publishes to GHCR
# (docker-compose*.ghcr.yml overlays); pass --build to compile on this host.
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
IMAGE_SOURCE="$(read_plan imageSource)"
OVERLAY_FILE="$(read_plan overlayFile)"
SCALE_TRANSFER="$(read_plan scaleTransfer)"
NEED_CERTS="$(read_plan needCerts)"
ROLE="$(read_plan role)"
ENV_FILE="$(read_plan envFile)"
EXTERNAL_DB="$(read_plan externalDb)"
DB_ADDR="$(read_plan dbHost)"
log "Plan: compose=$COMPOSE_FILE role=$ROLE images=$IMAGE_SOURCE${OVERLAY_FILE:+ overlay=$OVERLAY_FILE}${ENV_FILE:+ env=$ENV_FILE}${DB_ADDR:+ db=$DB_ADDR} scale=${SCALE_TRANSFER:-none}"

# 3b. Compose file list. GHCR deploys append the pull-only overlay AFTER the
# base file, so the published image refs win over the base build: definitions.
# NOTE: the overlay cannot delete the base build: keys — "pull" below is what
# guarantees the published image actually exists locally before "up".
COMPOSE_FILES=(-f "$COMPOSE_FILE")
# db hosts build/pull nothing of ours, so the plan leaves overlayFile empty —
# never hand compose a bare `-f ""`.
if [ "$IMAGE_SOURCE" = "ghcr" ] && [ -n "$OVERLAY_FILE" ]; then
  COMPOSE_FILES+=(-f "$OVERLAY_FILE")
fi
# core + external Postgres: this overlay profile-gates the local `postgres`
# service out, so the control plane never starts a second database.
if [ "$ROLE" = "core" ] && [ "$EXTERNAL_DB" = "true" ]; then
  COMPOSE_FILES+=(-f docker-compose.core.extdb.yml)
fi

# The CORE host is the control plane and the CA origin: it must run first, mint
# the shared gRPC CA (gen-grpc-certs.sh), then its certs are copied to the go
# host out-of-band. A single-host script cannot orchestrate that ordering, so
# core stays configure-and-hand-off (print exact deploy steps, do not deploy).
# go auto-deploys further below — it only VERIFIES the copied certs, never mints.
if [ "$ROLE" = "core" ]; then
  FILES="${COMPOSE_FILES[*]}"
  NEXT_STEP=4
  log "Core host config written. install.sh does NOT auto-deploy the core control plane."
  printf '\n  Complete the core deploy manually on THIS host:\n\n'
  printf '  1. Mint the shared gRPC CA on this CORE host only:\n'
  printf '       ./scripts/gen-grpc-certs.sh\n'
  printf '  2. Copy certs/grpc/{ca.crt,backend-transfer.crt,backend-transfer.key} to the go host.\n'
  printf '  3. REDIS_PASSWORD in %s must match the value on the go host.\n' "$ENV_FILE"
  if [ "$EXTERNAL_DB" = "true" ]; then
    printf '  4. Postgres runs on the DB-ONLY host (%s), not on this one:\n' "${DB_ADDR:-<DB_HOST>}"
    printf '     - the commands below include docker-compose.core.extdb.yml, which\n'
    printf '       profile-gates the local Postgres container out.\n'
    printf '     - firewall 5432 on that host to THIS host only.\n'
    NEXT_STEP=5
  fi
  printf '  %s. Bring up the control plane:\n' "$NEXT_STEP"
  if [ "$IMAGE_SOURCE" = "ghcr" ]; then
    printf '       docker compose --env-file %s %s pull\n' "$ENV_FILE" "$FILES"
    printf '       docker compose --env-file %s %s up -d\n' "$ENV_FILE" "$FILES"
    printf '     (pin a fixed release: TELE_DRIVE_IMAGE_TAG=sha-<short> in %s)\n' "$ENV_FILE"
    printf '  Build images on this host instead: %s --build\n\n' "$0"
  else
    printf '       docker compose --env-file %s %s up -d --build\n\n' "$ENV_FILE" "$FILES"
  fi
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
# Compose auto-loads only ./.env, so every split role names its file (.env.db on
# a db-only host, .env.transfer on the go host; core exits above). mono/scale
# keep using the auto-loaded ./.env — the plan leaves envFile empty for them.
if [ -n "$ENV_FILE" ]; then
  ENV_FILE_ARGS=(--env-file "$ENV_FILE")
fi
# ${arr[@]+"${arr[@]}"} expands to nothing when the array is empty (mono/scale),
# instead of a spurious "" arg — and stays safe under `set -u` on bash 3.2+.

# GHCR mode: pull FIRST. The base files keep "build:" and the overlay cannot
# remove it, so an "up" without a successful pull would silently build from
# source on a host that still has the repo — exactly what this mode must avoid.
if [ "$IMAGE_SOURCE" = "ghcr" ]; then
  log "Pulling prebuilt images from GHCR (${TELE_DRIVE_IMAGE_PREFIX:-default prefix}:${TELE_DRIVE_IMAGE_TAG:-latest})..."
  if ! docker compose ${ENV_FILE_ARGS[@]+"${ENV_FILE_ARGS[@]}"} "${COMPOSE_FILES[@]}" pull; then
    err "Image pull failed."
    printf '  Usual causes: private GHCR packages (docker login ghcr.io first), an unknown\n' >&2
    printf '  TELE_DRIVE_IMAGE_TAG, a fork where TELE_DRIVE_IMAGE_PREFIX no longer applies, or no network.\n' >&2
    printf '  Fallback (compile on this host): %s --build\n' "$0" >&2
    rm -f "$PLAN_FILE"
    exit 1
  fi
  log "Pull complete."
fi

UP_ARGS=(${ENV_FILE_ARGS[@]+"${ENV_FILE_ARGS[@]}"} "${COMPOSE_FILES[@]}" up -d)
[ "$IMAGE_SOURCE" = "build" ] && UP_ARGS+=(--build)
# Belt-and-suspenders for GHCR mode: even without an explicit pull (e.g. up run
# from inside the wizard's plan), compose must prefer the registry image.
[ "$IMAGE_SOURCE" = "ghcr" ] && UP_ARGS+=(--pull always)
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
  STATUS="$(docker compose ${ENV_FILE_ARGS[@]+"${ENV_FILE_ARGS[@]}"} "${COMPOSE_FILES[@]}" ps --format '{{.Service}} {{.Health}}' 2>/dev/null || true)"
  BT_TOTAL="$(printf '%s\n' "$STATUS" | awk '$1=="backend-transfer"' | wc -l | tr -d ' ')"
  BT_OK="$(printf '%s\n' "$STATUS" | awk '$1=="backend-transfer" && $2=="healthy"' | wc -l | tr -d ' ')"
  if [ "$ROLE" = "db" ]; then
    # Database-only host: `postgres` healthy is the entire signal.
    PG_TOTAL="$(printf '%s\n' "$STATUS" | awk '$1=="postgres"' | wc -l | tr -d ' ')"
    PG_OK="$(printf '%s\n' "$STATUS" | awk '$1=="postgres" && $2=="healthy"' | wc -l | tr -d ' ')"
    if [ "$PG_TOTAL" -ge 1 ] && [ "$PG_OK" -eq "$PG_TOTAL" ]; then
      HEALTHY=1
      break
    fi
  elif [ "$ROLE" = "go" ]; then
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
  docker compose ${ENV_FILE_ARGS[@]+"${ENV_FILE_ARGS[@]}"} "${COMPOSE_FILES[@]}" logs --tail 200 2>/dev/null \
    | grep -iE "wrongpass|noauth|cert|tls|can't resolve|permission denied" | tail -20 || true
  rm -f "$PLAN_FILE"
  exit 1
fi

# 6b. db-only host: print the cross-host handoff. No certs, no Redis, no backend
# here — the only thing the core host needs is this database's address + password.
if [ "$ROLE" = "db" ]; then
  log "Postgres is up on this host (${DB_ADDR:-<private-ip>})."
  printf '\n  On the CONTROL-PLANE host, set in .env.core:\n'
  printf '    DB_HOST=%s\n' "${DB_ADDR:-<private-ip>}"
  printf '    POSTGRES_PASSWORD=<the value in .env.db on this host>\n'
  printf '  Then deploy core WITH the external-db overlay:\n'
  printf '    docker compose --env-file .env.core \\\n'
  printf '      -f docker-compose.core.yml -f docker-compose.core.extdb.yml up -d\n'
  printf '  Firewall 5432 on this host to the CORE host only.\n'
  printf '  Backups: docker compose --env-file .env.db -f docker-compose.db.yml \\\n'
  printf '    exec -T postgres pg_dump -U tele_drive -Fc tele_drive > tele_drive.dump\n\n'
fi

# 7. Cleanup scratch plan.
rm -f "$PLAN_FILE"
log "Done."