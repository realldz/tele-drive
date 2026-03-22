/**
 * Upload configuration for Tele-Drive
 *
 * Adjust MAX_CHUNK_SIZE based on your Telegram API setup:
 *
 *   Bot API (cloud):
 *     - Upload limit:   50 MB
 *     - Download limit:  20 MB
 *     → Chunk size should be < 20MB → default 19MB
 *
 *   Local Bot API Server:
 *     - Upload limit:   2 GB
 *     - Download limit:  2 GB
 *     → Chunk size can be up to ~1.9 GB
 *
 * Override via environment variable: MAX_CHUNK_SIZE (in bytes)
 * Example .env:
 *   MAX_CHUNK_SIZE=19922944        # 19 MB (Bot API cloud)
 *   MAX_CHUNK_SIZE=2040109465      # ~1.9 GB (Local Bot API Server)
 */

// Default: 19 MB = 19 * 1024 * 1024 = 19922944 bytes
export const MAX_CHUNK_SIZE = parseInt(
  process.env.MAX_CHUNK_SIZE || String(19 * 1024 * 1024),
  10,
);
