export const uploadBufferConfig = {
  /** Max size per item (file hoặc chunk) để được buffer. Vượt quá → direct upload */
  maxBufferFileSize: parseInt(
    process.env.MAX_BUFFER_FILE_SIZE || '52428800',
    10,
  ), // 50MB

  /** Tổng dung lượng temp storage tối đa (MB) */
  maxBufferDiskMb: parseInt(process.env.MAX_BUFFER_DISK_MB || '2048', 10), // 2GB

  /** Ngưỡng backpressure: khi disk usage > 80% → fallback direct upload */
  backpressureThreshold: 0.8,

  /** Max items per sendMediaGroup batch */
  maxBatchSize: parseInt(process.env.MAX_BATCH_SIZE || '10', 10),

  /** Max total size per batch (bytes) */
  maxBatchTotalSize: parseInt(
    process.env.MAX_BATCH_TOTAL_SIZE || '314572800',
    10,
  ), // 300MB

  /** Max giờ file ở trạng thái buffered trước khi expire */
  bufferTtlHours: parseInt(process.env.BUFFER_TTL_HOURS || '24', 10),

  /** Max retries trước khi mark buffer_failed */
  maxRetries: parseInt(process.env.BUFFER_MAX_RETRIES || '3', 10),

  /** Dispatch interval (seconds) */
  dispatchIntervalSec: parseInt(
    process.env.BUFFER_DISPATCH_INTERVAL || '3',
    10,
  ),
};
