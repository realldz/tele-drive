FROM node:20-alpine AS builder

WORKDIR /app

# Install ALL dependencies (including devDeps for nest build)
COPY package*.json ./
RUN npm ci

# Generate Prisma client
COPY prisma ./prisma/
RUN npx prisma generate

# Build application
COPY . .
RUN npm run build

# --- Production runner ---
FROM node:20-alpine

WORKDIR /app

# Install production dependencies only
COPY package*.json ./
RUN npm ci --omit=dev

# Copy Prisma schema + generated client
COPY prisma ./prisma/
RUN npx prisma generate

# Copy built output
COPY --from=builder /app/dist ./dist

EXPOSE 3001

# Push schema to DB on startup, then run
CMD ["sh", "-c", "npx prisma db push --skip-generate && node dist/main"]
