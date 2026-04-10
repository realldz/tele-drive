# Winston Logging Improvement Plan

> **Mục tiêu:** Thay thế NestJS Logger mặc định bằng Winston, ghi log ra file JSON với rotation, thêm request tracing và global exception filter.

---

## Vấn đề hiện tại

| # | Vấn đề | Mức độ |
|---|--------|--------|
| 1 | Không ghi log ra file — mất log khi container restart | 🔴 Nghiêm trọng |
| 2 | `FolderController` không có bất kỳ log nào | 🟡 Thiếu |
| 3 | `BandwidthInterceptor` không log lock/refund/quota violations | 🟡 Thiếu |
| 4 | `FileController` thiếu log cho CRUD operations | 🟡 Thiếu |
| 5 | Không có request ID — khó trace request xuyên services | 🟡 Thiếu |
| 6 | Không có global exception filter — stack trace không được log nhất quán | 🟡 Thiếu |
| 7 | `TrashCleanupService` error logs thiếu stack trace | 🟢 Minor |

---

## Kiến trúc Logging

### Cấu trúc file log

```
backend/.logs/
├── combined-2026-04-10.log      # Tất cả logs (info+ trở lên)
├── combined-2026-04-11.log      # Auto rotate hàng ngày
├── error-2026-04-10.log         # Chỉ errors
├── error-2026-04-11.log
└── error-2026-04-10.log.gz      # Auto compress file cũ
```

### JSON log format (production)

```json
{
  "timestamp": "2026-04-10T12:00:00.000Z",
  "level": "error",
  "context": "FileService",
  "message": "Upload failed for file-abc123",
  "requestId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "stack": "Error: ECONNRESET\n  at ...",
  "trace": "POST /api/files/upload 500 1234ms"
}
```

### Colored console format (development)

```
[Nest] 1234  - 04/10/2026, 12:00:00 PM   LOG [FileService] [req:a1b2c3d4] Upload complete: file-abc123
```

---

## Log Level Strategy

| Môi trường | Console level | File level | Format |
|------------|---------------|------------|--------|
| `development` | `debug` | `debug` | Colored + simple |
| `production` | `warn` | `info` | JSON |

Override qua biến môi trường: `LOG_LEVEL=debug`

### Winston vs NestJS built-in level mapping

| Winston | NestJS | Method |
|---------|--------|--------|
| `error` | `error` | `logger.error(msg)` |
| `warn` | `warn` | `logger.warn(msg)` |
| `info` | `log` | `logger.log(msg)` |
| `http` | — | `logger.log(msg, 'HTTP')` |
| `debug` | `debug` | `logger.debug(msg)` |
| `verbose` | `verbose` | `logger.verbose(msg)` |

---

## Task List

### Phase 1: Core Winston Setup

| # | Task | Files | Trạng thái |
|---|------|-------|------------|
| 1.1 | Install dependencies: `nest-winston winston winston-daily-rotate-file` | `package.json` | ✅ Done |
| 1.2 | Tạo Winston config | `common/logger/winston.config.ts` | ✅ Done |
| 1.3 | Tạo Logger module | `common/logger/logger.module.ts` | ✅ Done |

**Chi tiết 1.2 — `winston.config.ts`:**
- Đọc từ `LOG_LEVEL` hoặc `NODE_ENV`
- Console transport (colorize cho dev, JSON cho prod)
- Daily rotate file: 2 transports (combined + error-only)
- Rotation: giữ 14 ngày, max size 10MB/file, compress thành `.gz`
- JSON format: `{ timestamp, level, context, message, stack?, trace? }`
- Combine: `timestamp() + json() + errors({ stack: true }) + printf()`

**Chi tiết 1.3 — `logger.module.ts`:**
- Dùng `WinstonModule.forRootAsync()` để inject `ConfigService`
- Export cho toàn app

---

### Phase 2: Request ID & Global Exception Filter

| # | Task | Files | Trạng thái |
|---|------|-------|------------|
| 2.1 | Tạo request ID middleware | `common/middleware/request-id.middleware.ts` | ✅ Done |
| 2.2 | Tạo global exception filter | `common/filters/global-exception.filter.ts` | ✅ Done |

**Chi tiết 2.1 — Request ID:**
- Tự generate UUID v4 nếu client không gửi `X-Request-ID`
- Lưu vào `req.requestId`
- Tất cả log messages sẽ include `{ requestId: req.requestId }`
- Response header thêm `X-Request-ID` để client dễ debug

**Chi tiết 2.2 — Global Exception Filter:**
- `@Catch()` — catch mọi exception chưa được handle
- Log full stack trace + context + requestId
- Trả về client response an toàn (không leak internal details)
- Format: `{ statusCode, message, timestamp, path }`

---

### Phase 3: Integration

| # | Task | Files | Trạng thái |
|---|------|-------|------------|
| 3.1 | Update `main.ts` — integrate Winston, middleware, filter | `main.ts` | ✅ Done |
| 3.2 | Thêm env vars | `backend/.env` | ✅ Done |
| 3.3 | Thêm log volume mount | `docker-compose.yml` | ✅ Done |
| 3.4 | Tạo log directory trong Dockerfile | `backend/Dockerfile` | ✅ Done |
| 3.5 | Thêm `.logs/` vào `.gitignore` | `.gitignore` | ✅ Done |

**Chi tiết 3.1 — `main.ts` thay đổi:**
```typescript
// Before
const app = await NestFactory.create(AppModule, {
  bodyParser: false,
  logger: isProduction ? ['error', 'warn', 'log'] : ['error', 'warn', 'log', 'debug', 'verbose'],
});

// After
const app = await NestFactory.create(AppModule, {
  bodyParser: false,
  logger: WinstonModule.createLogger(winstonConfig),
});

// Thêm:
app.use(requestIdMiddleware);
app.useGlobalFilters(new GlobalExceptionFilter());
```

**Chi tiết 3.3 — `docker-compose.yml`:**
```yaml
backend:
  volumes:
    - ./.logs:/app/.logs
```

---

### Phase 4: Add Missing Logs

| # | Task | Files | Trạng thái |
|---|------|-------|------------|
| 4.1 | Thêm log cho FolderController | `folder/folder.controller.ts` | ✅ Done |
| 4.2 | Thêm log cho BandwidthInterceptor | `bandwidth.interceptor.ts` | ✅ Done |
| 4.3 | Thêm log cho FileController CRUD operations | `file/file.controller.ts` | ✅ Done |
| 4.4 | Cải thiện error logging cho TrashCleanupService | `trash-cleanup.service.ts` | ✅ Done |

**Chi tiết 4.1 — FolderController:**
- `create`: log folder name, userId, parentId, result
- `rename`: log old/new name, userId
- `move`: log source/target, userId, conflict action
- `softDelete`: log folderId, userId
- `restore`: log folderId, userId
- `permanentDelete`: log folderId, userId
- `share`/`unshare`: log folderId, userId, action

**Chi tiết 4.2 — BandwidthInterceptor:**
- Log khi bandwidth lock thành công
- Log warning khi quota exceeded (429)
- Log reconcile: refund amount, actual bytes
- Include requestId + userId/ip trong log

**Chi tiết 4.3 — FileController:**
- `upload`: log filename, size, userId, result
- `softDelete`/`permanentDelete`: log fileId, userId
- `restore`: log fileId, userId
- `rename`/`move`: log fileId, userId, action details
- `share`/`unshare`: log fileId, action

**Chi tiết 4.4 — TrashCleanupService:**
- Error logs bao gồm full stack trace (hiện tại chỉ log `err.toString()`)
- Dùng `err instanceof Error ? err.stack : String(err)`
- Log chi tiết hơn khi cleanup từng file/folder bị fail

---

## File mới sẽ tạo

```
backend/src/common/
├── logger/
│   ├── winston.config.ts        # Winston transports + format config
│   └── logger.module.ts         # WinstonModule.forRootAsync()
├── middleware/
│   └── request-id.middleware.ts # Generate/correlate request IDs
└── filters/
    └── global-exception.filter.ts # Catch-all error handler + log
```

## Files sẽ sửa

| File | Thay đổi |
|------|----------|
| `backend/package.json` | Thêm `nest-winston winston winston-daily-rotate-file` |
| `backend/src/main.ts` | Integrate Winston logger, register middleware + filter |
| `backend/src/folder/folder.controller.ts` | Thêm Logger cho tất cả endpoints |
| `backend/src/common/bandwidth.interceptor.ts` | Thêm log bandwidth events |
| `backend/src/file/file.controller.ts` | Thêm log CRUD operations |
| `backend/src/common/trash-cleanup.service.ts` | Cải thiện error stack logging |
| `backend/.env` | Thêm `LOG_LEVEL`, `LOG_DIR`, `LOG_MAX_FILES` |
| `docker-compose.yml` | Thêm volume `.logs:/app/.logs` |
| `backend/Dockerfile` | Tạo thư mục `.logs` |
| `.gitignore` | Thêm `.logs/` |

---

## Verification

Sau khi implement, kiểm tra:

```bash
# 1. Chạy backend dev
cd backend && npm run start:dev

# 2. Trigger actions (login, upload, rename folder, download)

# 3. Kiểm tra log files
ls -la backend/.logs/

# 4. Xem log content
cat backend/.logs/combined-$(date +%Y-%m-%d).log

# 5. Docker compose
docker compose up -d
docker compose logs -f backend
ls -la .logs/  # Trên host

# 6. Verify request ID trong response header
curl -v http://localhost/api/files/config
# → Xem X-Request-ID trong response headers
```

---

## Dependencies

```json
{
  "nest-winston": "^1.0.0",
  "winston": "^3.17.0",
  "winston-daily-rotate-file": "^5.0.0"
}
```
