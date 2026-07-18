// Named constants replacing magic literals throughout the codebase

// Pagination
export const PAGINATION_FOLDER_LIMIT = 50;
export const PAGINATION_DEFAULT_LIMIT = 20;

// Upload
export const UPLOAD_MAX_CHUNK_RETRIES = 5;
export const UPLOAD_RETRY_AFTER_429_S = 5;
export const UPLOAD_RETRY_AFTER_503_S = 10;
export const UPLOAD_SMALL_FILE_BATCH = 5;
export const UPLOAD_POLL_INTERVAL_MS = 3000;
// Minimum spacing between the START of consecutive upload requests (init,
// chunk, complete). Smooths small-file bursts to avoid 429 / server load;
// large-file chunks are unaffected since their upload duration >> this interval.
export const UPLOAD_MIN_REQUEST_INTERVAL_MS = 500;

// Download
export const DOWNLOAD_CLEANUP_DELAY_MS = 2000;

// UI feedback
export const COPY_FEEDBACK_RESET_MS = 2000;

// Trash
export const TRASH_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;
export const TRASH_CLEANUP_POLL_MS = 2000;

// Toast durations (react-hot-toast duration option)
export const TOAST_SHORT_MS = 2000;
export const TOAST_LONG_MS = 5000;

// Infinite scroll
export const LOAD_MORE_ROOT_MARGIN = '200px';

// Global search
export const SEARCH_DEBOUNCE_MS = 300;

// Format categories — labels MUST match backend FORMAT_CATEGORIES
// (backend/src/folder/file-format-category.ts). Backend owns the mime/ext
// resolution; frontend only sends the category label. Keep the two in sync.
export const SEARCH_FORMAT_CATEGORIES = [
  'image',
  'video',
  'audio',
  'document',
  'archive',
  'other',
] as const;

export type SearchFormatCategory = (typeof SEARCH_FORMAT_CATEGORIES)[number];

export type SearchTypeFilter = 'all' | 'folder' | 'file';

// Time-range presets. `days` resolves to createdFrom = now - days; null = all-time.
export const SEARCH_TIME_PRESETS = [
  { key: 'all', days: null },
  { key: 'today', days: 1 },
  { key: '7d', days: 7 },
  { key: '30d', days: 30 },
  { key: 'year', days: 365 },
] as const;

export type SearchTimePresetKey = (typeof SEARCH_TIME_PRESETS)[number]['key'];

// HTTP client
export const API_TIMEOUT_MS = 90000;

// Admin logs
export const ADMIN_LOGS_DEFAULT_LIMIT = 100;
export const ADMIN_LOGS_MAX_LIMIT = 5000;
