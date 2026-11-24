# Build on the host architecture ($BUILDPLATFORM) to avoid running Next.js/V8
# multi-worker builds under QEMU arm64 emulation (slow and prone to SIGILL).
FROM --platform=$BUILDPLATFORM node:22.23.4-alpine AS builder

WORKDIR /app

ENV NPM_CONFIG_FETCH_RETRIES=5 \
    NPM_CONFIG_FETCH_RETRY_FACTOR=2 \
    NPM_CONFIG_FETCH_RETRY_MINTIMEOUT=2000 \
    NPM_CONFIG_FETCH_RETRY_MAXTIMEOUT=120000 \
    NPM_CONFIG_AUDIT=false \
    NPM_CONFIG_FUND=false

COPY package*.json ./
RUN npm ci --prefer-offline

COPY . .

# NEXT_PUBLIC_* vars are baked at build time. Only the control-plane origin
# stays here: the data-plane transfer origin + S3 domain are served at runtime
# by backend-core (GET /api/v1/client-config, sourced from PUBLIC_TRANSFER_URL
# and S3_DOMAIN) and applied by src/lib/api/client-config.ts, so enabling them
# no longer requires a frontend rebuild.
ARG NEXT_PUBLIC_API_URL=/api
ENV NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL}

RUN npm run build

# --- Swap sharp native binaries when cross-compiling (e.g. amd64 -> arm64) ---
FROM --platform=$BUILDPLATFORM node:22.23.4-alpine AS standalone
ARG BUILDARCH
ARG TARGETARCH

WORKDIR /app

ENV NPM_CONFIG_FETCH_RETRIES=5 \
    NPM_CONFIG_FETCH_RETRY_FACTOR=2 \
    NPM_CONFIG_FETCH_RETRY_MINTIMEOUT=2000 \
    NPM_CONFIG_FETCH_RETRY_MAXTIMEOUT=120000 \
    NPM_CONFIG_AUDIT=false \
    NPM_CONFIG_FUND=false

COPY --from=builder /app/.next/standalone ./

RUN if [ "$BUILDARCH" != "$TARGETARCH" ] && [ -f node_modules/sharp/package.json ]; then \
      case "$TARGETARCH" in \
        amd64) NPM_ARCH=x64 ;; \
        arm64) NPM_ARCH=arm64 ;; \
        *) NPM_ARCH="$TARGETARCH" ;; \
      esac && \
      SHARP_PKG=$(node -p "const d=require('./node_modules/sharp/package.json').optionalDependencies||{}; const k='@img/sharp-linuxmusl-${NPM_ARCH}'; d[k] ? k+'@'+d[k] : ''") && \
      VIPS_PKG=$(node -p "const d=require('./node_modules/sharp/package.json').optionalDependencies||{}; const k='@img/sharp-libvips-linuxmusl-${NPM_ARCH}'; d[k] ? k+'@'+d[k] : ''") && \
      if [ -n "$SHARP_PKG" ] && [ -n "$VIPS_PKG" ]; then \
        mkdir -p /tmp/sharp && \
        npm --prefix /tmp/sharp install --no-save --no-package-lock --force "$SHARP_PKG" "$VIPS_PKG" && \
        rm -rf node_modules/@img/sharp-linuxmusl-* node_modules/@img/sharp-libvips-linuxmusl-* && \
        mkdir -p node_modules/@img && \
        cp -a /tmp/sharp/node_modules/@img/sharp-linuxmusl-* /tmp/sharp/node_modules/@img/sharp-libvips-linuxmusl-* node_modules/@img/ && \
        rm -rf /tmp/sharp; \
      fi; \
    fi

# --- Production runner ---
FROM node:22.23.4-alpine AS runner

WORKDIR /app
ENV NODE_ENV=production

# Copy standalone output
COPY --from=standalone /app ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public

EXPOSE 3000

CMD ["node", "server.js"]
