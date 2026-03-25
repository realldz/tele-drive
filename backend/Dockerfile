FROM node:20-alpine

WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm ci --omit=dev

# Generate Prisma client
COPY prisma ./prisma/
RUN npx prisma generate

# Build application
COPY . .
RUN npm run build

# Create data directory for SQLite volume mount
RUN mkdir -p /data

EXPOSE 3001

# Push schema to DB on startup, then run
CMD ["sh", "-c", "npx prisma db push --skip-generate && node dist/main"]
