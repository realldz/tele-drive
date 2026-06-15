#!/usr/bin/env bash
# Generate an internal CA + leaf certs for bidirectional gRPC mTLS between the
# NestJS core service and the Go transfer service.
#
#   NestJS CoreService     = gRPC server ; Go is its client
#   Go TransferService     = gRPC server ; NestJS is its client
#
# Each leaf cert carries BOTH serverAuth + clientAuth EKUs so one cert per side
# serves both roles. The SAN must match the dns:/// authority the peer dials
# (backend-core / backend-transfer) so hostname verification passes — including
# under `docker compose --scale`, where every replica shares the service cert
# and the authority stays the service name, not the per-container hostname.
#
# Certs are NOT committed (see .gitignore). Re-run to rotate; the CA is reused
# if present so peers already trusting it keep validating.
#
# Usage:  scripts/gen-grpc-certs.sh [CERT_DIR]   (default: ./certs/grpc)
#   DAYS_CA / DAYS_LEAF env vars override validity (default 10y CA, ~2y leaf).
set -euo pipefail

# Git Bash (MSYS) rewrites leading-slash args like "/CN=..." into Windows paths,
# corrupting the openssl -subj string. Disable that conversion; harmless on Linux.
export MSYS_NO_PATHCONV=1

CERT_DIR="${1:-./certs/grpc}"
DAYS_CA="${DAYS_CA:-3650}"
DAYS_LEAF="${DAYS_LEAF:-825}"

mkdir -p "$CERT_DIR"
cd "$CERT_DIR"

# ─── Internal CA (reused if already present) ────────────────────────────────
if [[ ! -f ca.key || ! -f ca.crt ]]; then
  echo "Generating internal CA (valid ${DAYS_CA} days)..."
  openssl genrsa -out ca.key 4096
  openssl req -x509 -new -nodes -key ca.key -sha256 -days "$DAYS_CA" \
    -subj "/CN=tele-drive-grpc-ca/O=tele-drive" -out ca.crt
else
  echo "Reusing existing CA (ca.crt / ca.key)."
fi

# ─── Leaf cert: CN + primary SAN both equal the dns:/// service name ─────────
gen_leaf() {
  local name="$1"  # file prefix == service name == SAN
  echo "Generating leaf cert for '${name}' (valid ${DAYS_LEAF} days)..."
  openssl genrsa -out "${name}.key" 2048
  openssl req -new -key "${name}.key" -subj "/CN=${name}/O=tele-drive" -out "${name}.csr"
  # Write the extension file to a real path: native (non-MSYS) OpenSSL cannot
  # read the /dev/fd/NN process-substitution handles that bash would otherwise use.
  printf "subjectAltName=DNS:%s,DNS:localhost\nextendedKeyUsage=serverAuth,clientAuth\n" "$name" > "${name}.ext"
  openssl x509 -req -in "${name}.csr" -CA ca.crt -CAkey ca.key -CAcreateserial \
    -days "$DAYS_LEAF" -sha256 \
    -extfile "${name}.ext" \
    -out "${name}.crt"
  rm -f "${name}.csr" "${name}.ext"
}

gen_leaf backend-core
gen_leaf backend-transfer

echo "Done. Certs written to: $(pwd)"
ls -1
