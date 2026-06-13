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

// HTTP client
export const API_TIMEOUT_MS = 30000;

// Admin logs
export const ADMIN_LOGS_DEFAULT_LIMIT = 100;
export const ADMIN_LOGS_MAX_LIMIT = 5000;
