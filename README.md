# Tele-Drive

Cloud storage powered by Telegram. Store, manage, and share files using Telegram as the storage backend with end-to-end encryption, S3-compatible API, and a modern web interface.

## Features

- **Unlimited storage** — files are stored as encrypted chunks on Telegram
- **AES-256-CTR encryption** — per-chunk encryption with master secret key management
- **Chunked upload/download** — support for large files with multi-bot parallel uploads
- **File preview** — built-in viewers for images, video (Plyr), audio, PDF (react-pdf), and code (highlight.js)
- **Folder management** — create, rename, move, and organize files into folders
- **Sharing** — generate public share links for files and folders
- **Trash bin** — soft delete with 7-day auto-cleanup
- **S3-compatible API** — use `aws-cli`, `s3cmd`, or any S3 client with presigned URL support
- **Admin dashboard** — user management, quota control, system settings
- **Multi-language UI** — English, Vietnamese, Chinese, Japanese
- **Docker deployment** — one-command setup with Telegram Local Bot API server

## Architecture

```
                     ┌──────────────────┐
       Users ──────► │    nginx :80     │
                     │ (reverse proxy)  │
                     └──┬────────┬──────┘
                        │        │
              /api/*    │        │  /*
                        ▼        ▼
                ┌──────────┐ ┌──────────┐
                │ Backend  │ │ Frontend │
                │ NestJS   │ │ Next.js  │
                │  :3001   │ │  :3000   │
                └────┬─────┘ └──────────┘
                     │
                     ▼
              ┌──────────────┐    ┌────────────────┐
              │ nginx :8088  │───►│ telegram-bot-   │
              │ (file proxy) │    │ api :8081       │
              └──────────────┘    │ (Local Bot API) │
                                  └────────────────┘
```

## Prerequisites

- **Docker** and **Docker Compose** (for Docker deployment)
- **Node.js 20+** (for local development)
- **Telegram Bot** — create via [@BotFather](https://t.me/BotFather)
- **Telegram API credentials** — get `api_id` and `api_hash` from [my.telegram.org](https://my.telegram.org)
- **Telegram Channel/Group** — add bot as admin, get the chat ID

## Quick Start (Local Development)

### 1. Clone the repository

```bash
git clone https://github.com/realldz/tele-drive.git
cd tele-drive
```

### 2. Setup Backend

```bash
cd backend
cp .env.example .env
# Edit .env with your Telegram bot token, chat ID, and secrets
# Start PostgreSQL first, then point DATABASE_URL to it
npm install
npx prisma db push
npm run start:dev
```

### 3. Setup Frontend

```bash
cd frontend
cp .env.example .env.local
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

## Docker Deployment

### 1. Configure environment

```bash
# Root .env (for Docker Compose — Telegram API credentials)
cp .env.example .env
# Edit: TELEGRAM_API_ID, TELEGRAM_API_HASH

# Backend .env (bot token, chat ID, secrets)
cp backend/.env.example backend/.env
# Edit: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, JWT_SECRET, MASTER_SECRET
```

### 2. Deploy

#### Option A: Self-hosted (expose port 80)

```bash
docker compose up -d
```

Access at [http://localhost](http://localhost).

#### Option B: Cloudflare Tunnel (no port exposure)

```bash
# Add tunnel token to .env
echo 'CLOUDFLARE_TUNNEL_TOKEN=your_token' >> .env

docker compose --profile tunnel up -d
```

Configure routing in [Cloudflare Zero Trust](https://one.dash.cloudflare.com/) dashboard:
- Public hostname → Service: `http://nginx:80`

### Per-service commands

| Action | Command |
|--------|---------|
| Start all | `docker compose up -d` |
| Stop all | `docker compose down` |
| Rebuild + restart one service | `docker compose up -d --build backend` |
| Force rebuild (no cache) | `docker compose build --no-cache frontend` |
| Force rebuild + restart all | `docker compose up -d --build --force-recreate` |
| Restart (no rebuild) | `docker compose restart frontend` |
| View logs | `docker container logs -f backend` |
| Rebuild all | `docker compose build` |

## Environment Variables

### Backend (`backend/.env`)

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `DATABASE_URL` | Yes | `postgresql://tele_drive:tele_drive@localhost:5432/tele_drive` | PostgreSQL connection string |
| `TELEGRAM_BOT_TOKEN` | Yes | — | Bot token from @BotFather |
| `TELEGRAM_CHAT_ID` | Yes | — | Private channel/group ID |
| `JWT_SECRET` | Yes | — | JWT signing secret |
| `MASTER_SECRET` | Yes | — | AES-256-CTR key (32 chars) |
| `TELEGRAM_API_ROOT` | No | Cloud API | Local Bot API URL |
| `TELEGRAM_UPLOAD_BOT_TOKENS` | No | — | Extra upload bots (comma-separated) |
| `TELEGRAM_SEND_RATE_LIMIT` | No | `18` | Rate limit per bot (msg/min) |
| `MAX_CHUNK_SIZE` | No | ~19MB | Max chunk size in bytes |
| `PORT` | No | `3001` | Server port |

### Frontend (`frontend/.env.local`)

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `NEXT_PUBLIC_API_URL` | Yes | `http://localhost:3001` | Backend API URL (`/api` for Docker) |

### Docker Compose (`.env`)

| Variable | Required | Description |
|----------|----------|-------------|
| `TELEGRAM_API_ID` | Yes | From [my.telegram.org](https://my.telegram.org) |
| `TELEGRAM_API_HASH` | Yes | From [my.telegram.org](https://my.telegram.org) |
| `CLOUDFLARE_TUNNEL_TOKEN` | No | For `--profile tunnel` |
| `NGINX_PORT` | No | Nginx exposed port (default: 80) |
| `NEXT_PUBLIC_API_URL` | No | Frontend API URL, baked at build time (default: `/api`) |

## S3-Compatible API

Tele-Drive exposes an S3-compatible API for integration with standard S3 tools.

```bash
# Generate S3 credentials from the web UI (Settings → S3 Keys)

# Configure aws-cli
aws configure --profile tele-drive
# Access Key ID: <from web UI>
# Secret Access Key: <from web UI>

# Usage
aws --profile tele-drive --endpoint-url http://localhost:3001/s3 \
  s3 cp ./myfile.pdf s3://my-bucket/myfile.pdf

aws --profile tele-drive --endpoint-url http://localhost:3001/s3 \
  s3 ls s3://my-bucket/
```

Supported operations: `PutObject`, `GetObject`, `DeleteObject`, `HeadObject`, `ListObjectsV2`, `CopyObject`, multipart upload, presigned URLs.

### Recommended aws-cli config (avoid rate limiting)

Tele-Drive limits concurrent chunk uploads per user (default: **3**). `aws-cli` sends up to 10 multipart parts in parallel by default, which will trigger **HTTP 429** errors. Add the following to `~/.aws/config`:

```ini
[profile tele-drive]
region = us-east-1
s3 =
  max_concurrent_requests = 3
  multipart_threshold = 64MB
  multipart_chunksize = 16MB
cli_read_timeout = 300
cli_connect_timeout = 60
```

| Parameter | Value | Why |
|-----------|-------|-----|
| `max_concurrent_requests` | `3` | Match the server's `MAX_CONCURRENT_CHUNKS` setting |
| `multipart_chunksize` | `16MB` | Stay below the server's max chunk size (~19 MB) |
| `multipart_threshold` | `64MB` | Only use multipart for files larger than 64 MB |
| `cli_read_timeout` | `300` | Allow enough time for large chunk uploads on slow connections |

## Upload Rate Limiting

Tele-Drive enforces a **per-user limit on concurrent chunk uploads** to prevent overloading the Telegram Bot API.

| Setting | Default | Description |
|---------|---------|-------------|
| `MAX_CONCURRENT_CHUNKS` | `3` | Maximum chunks a single user can upload simultaneously |

### How it works

1. **Server-side enforcement** — When a user exceeds the concurrent chunk limit, the backend returns **HTTP 429 Too Many Requests** with a `retryAfter` value (seconds).
2. **Client auto-retry** — The frontend automatically retries the rejected chunk after waiting `retryAfter` seconds, up to 5 attempts per chunk.
3. **Server-driven config** — On page load, the frontend fetches `GET /api/files/config` to get `maxConcurrentChunks` and `maxChunkSize`, ensuring the client always respects the current server setting.

### Configuring

Admins can change `MAX_CONCURRENT_CHUNKS` in the **Admin Dashboard → System Settings** panel. The change takes effect within 30 seconds (server-side cache TTL).

> **Note:** This limit is per user, not global. Each user can upload up to `MAX_CONCURRENT_CHUNKS` chunks at the same time. Files smaller than `maxChunkSize` (~19 MB) are uploaded in a single request and are not affected by this limit.

## Tech Stack

- **Backend**: [NestJS](https://nestjs.com/) + [Prisma](https://prisma.io/) + PostgreSQL + [Telegraf](https://telegraf.js.org/)
- **Frontend**: [Next.js 16](https://nextjs.org/) + [Tailwind CSS](https://tailwindcss.com/) + [Plyr](https://plyr.io/) + [react-pdf](https://github.com/wojtekmaj/react-pdf)
- **Infrastructure**: Docker + nginx + [Telegram Local Bot API](https://github.com/aiogram/telegram-bot-api) + optional [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/)

## License

MIT
