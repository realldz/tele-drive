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

  /** Parallel upload workers per instance (0 = auto based on bot count) */
  dispatchConcurrency: parseInt(process.env.DISPATCH_CONCURRENCY || '0', 10),

  /** Max giờ file ở trạng thái buffered trước khi expire */
  bufferTtlHours: parseInt(process.env.BUFFER_TTL_HOURS || '24', 10),

  /** Max retries trước khi mark buffer_failed */
  maxRetries: parseInt(process.env.BUFFER_MAX_RETRIES || '3', 10),
};
