FROM node:22.23.4-alpine AS builder

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

# --- Production runner ---
FROM node:22.23.4-alpine AS runner

WORKDIR /app
ENV NODE_ENV=production

# Copy standalone output
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public

EXPOSE 3000

CMD ["node", "server.js"]
