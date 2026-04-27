FROM node:20-alpine AS builder

WORKDIR /app

ENV NPM_CONFIG_FETCH_RETRIES=5 \
    NPM_CONFIG_FETCH_RETRY_FACTOR=2 \
    NPM_CONFIG_FETCH_RETRY_MINTIMEOUT=2000 \
    NPM_CONFIG_FETCH_RETRY_MAXTIMEOUT=120000 \
    NPM_CONFIG_AUDIT=false \
    NPM_CONFIG_FUND=false

# Install ALL dependencies (including devDeps for nest build)
COPY package*.json ./
RUN npm ci --prefer-offline

# Generate Prisma client
COPY prisma ./prisma/
RUN npx prisma generate

# Build application
COPY . .
RUN npm run build

# --- Production runner ---
FROM node:20-alpine

WORKDIR /app

ENV NPM_CONFIG_FETCH_RETRIES=5 \
    NPM_CONFIG_FETCH_RETRY_FACTOR=2 \
    NPM_CONFIG_FETCH_RETRY_MINTIMEOUT=2000 \
    NPM_CONFIG_FETCH_RETRY_MAXTIMEOUT=120000 \
    NPM_CONFIG_AUDIT=false \
    NPM_CONFIG_FUND=false

# Install production dependencies only
COPY package*.json ./
RUN npm ci --omit=dev --prefer-offline

# Copy Prisma schema + generated client
COPY prisma ./prisma/
RUN npx prisma generate

# Copy built output
COPY --from=builder /app/dist ./dist

# Create log directory
RUN mkdir -p /app/.logs

EXPOSE 3001

# Push schema to DB on startup, then run
CMD ["sh", "-c", "npx prisma db push --skip-generate && node dist/main"]
