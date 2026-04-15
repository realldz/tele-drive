# Refactor Plan — Tele-Drive Frontend & Backend

> Created: 2026-04-15
> Status: ALL PHASES COMPLETE ✅

---

## Phase 1 Status: COMPLETED ✅ Loading Infrastructure

| Task | Files | Status |
|---|---|---|
| Install `nextjs-toploader` | `package.json` | ✅ Done |
| Create `NavigationLoader` + `NavigationContext` | `components/navigation-loader.tsx` | ✅ Done |
| Create `RequestTrackerProvider` + context | `lib/request-tracker.tsx` | ✅ Done |
| Create `LoadingOverlay` component (smooth fade in/out) | `components/loading-overlay.tsx` | ✅ Done |
| Axios instance (`api`) with 30s timeout | `lib/api.ts` | ✅ Done |
| Request/response interceptors — track pending + error toast | `lib/api.ts` | ✅ Done |
| Update `AuthProvider` to use shared `api` instance | `components/auth-context.tsx` | ✅ Done |
| Wrap `layout.tsx` with NavigationLoader + RequestTrackerProvider + LoadingOverlay | `app/layout.tsx` | ✅ Done |
| Disable nav buttons during navigation | `sidebar.tsx`, `login/page.tsx`, `register/page.tsx`, `admin/page.tsx` | ✅ Done |
| Cache Components enabled (`next.config.ts`) | `next.config.ts` | ✅ Done |

---

## Phase 2 Status: COMPLETED ✅ Backend Pagination

| Task | Endpoint | Cursor Strategy | Search Support | Status |
|---|---|---|---|---|
| Pagination DTO (`PaginationQueryDto`) | `common/dto/pagination-query.dto.ts` | — | — | ✅ Done |
| `PaginatedResponse<T>` type | `common/types/paginated-response.type.ts` | — | — | ✅ Done |
| `PaginatedFolderContent` type | `common/types/paginated-folder-content.type.ts` | — | — | ✅ Done |
| `UserService.findAll()` | `GET /users` | `id` ASC | `username ILIKE` | ✅ Done |
| `UserService.getUserFiles()` | `GET /users/:id/files` | `(createdAt, id)` DESC base64 | `filename ILIKE` | ✅ Done |
| `FolderService.getContent()` | `GET /folders/content` | 2 cursors (`f`, `fc`) | `name` + `filename ILIKE` | ✅ Done |
| `FolderService.listTrash()` (folders) | `GET /folders/trash/list` | `deletedAt, id` DESC base64 | `name ILIKE` | ✅ Done |
| `FileService.listTrash()` (files) | `GET /files/trash/list` | `deletedAt, id` DESC base64 | `filename ILIKE` | ✅ Done |
| `FolderService.getSharedContent()` | `GET /folders/share/:token` | 2 cursors (`f`, `fc`) | `name` + `filename ILIKE` | ✅ Done |

---

## Phase 3 Status: COMPLETED ✅ Frontend API + Hook

| Task | File | Status |
|---|---|---|
| Create `useServerPagination` hook | `hooks/use-server-pagination.ts` | ✅ Done |
| Update `fetchUsers(cursor?, search?)` | `lib/api.ts` | ✅ Done |
| Update `fetchUserFiles(userId, cursor?, search?)` | `lib/api.ts` | ✅ Done |
| Update `fetchFolderContent(folderId?, cursor?, search?)` | `lib/api.ts` | ✅ Done |
| Update `fetchTrashFolders(cursor?, search?)` | `lib/api.ts` | ✅ Done |
| Update `fetchTrashFiles(cursor?, search?)` | `lib/api.ts` | ✅ Done |
| Admin page compatibility — `res.data` access | `app/admin/page.tsx` | ✅ Done |
| Trash page compatibility — split fetch | `app/trash/page.tsx` | ✅ Done |

---

## Phase 4 Status: COMPLETED ✅ Per-Item Loading States

| Task | File | Implementation | Status |
|---|---|---|---|
| Create `useItemLoading` hook | `hooks/use-item-loading.ts` | `Set<string>` with `withLoading()` | ✅ Done |
| Dashboard: stuck file delete spinner | `components/dashboard/dashboard-content.tsx`, `app/page.tsx` | `actionLoading` prop | ✅ Done |
| Admin: delete user file spinner | `app/admin/components/user-management.tsx`, `app/admin/page.tsx` | `actionLoading` prop | ✅ Done |
| Trash: restore/delete per-item | `app/trash/page.tsx` | Pre-existing `actionIds` | ✅ Done |

---

## Phase 5 Status: COMPLETED ✅ Page Implementations

| Task | File | Changes | Status |
|---|---|---|---|
| Admin: paginated user list + file list | `app/admin/page.tsx`, `user-management.tsx` | Dual cursors, debounced search, load more button | ✅ Done |
| Trash: paginated folders + files | `app/trash/page.tsx` | Dual cursors, load more button | ✅ Done |
| Dashboard: server-side pagination | `app/page.tsx` | Replaced `useLazyLoad`, IntersectionObserver, `handleLoadMore()` | ✅ Done |
| Share folder: paginated content | `app/share/folder/[token]/page.tsx` | Cursors + IntersectionObserver + load more | ✅ Done |
| Share single file | `app/share/[token]/page.tsx` | No pagination needed (single item) | ✅ N/A |

---

## Phase 6 Status: COMPLETED ✅ Cleanup

| Task | File | Status |
|---|---|---|
| Deprecate `use-lazy-load.ts` | `hooks/use-lazy-load.ts` | ✅ Replaced with no-op stub |
| Remove all `useLazyLoad` imports | `app/page.tsx`, `admin/components/user-management.tsx` | ✅ Done |
| Remove `.slice(0, visibleCount)` pattern | All pages | ✅ Done |

---

## Summary: What Was Achieved

### Before
- **Lazy load:** Client-side `.slice()` — fetch ALL data, render gradually
- **Navigation:** No feedback, user can spam-click
- **Loading:** No timeout, no overlay, 1 global `isLoading` per page
- **Admin:** 220-line god component
- **Trash:** `alert()` for errors

### After
| Layer | Behavior |
|---|---|
| **Navigation** | NProgress bar + blur overlay + disabled buttons |
| **API Loading** | 30s timeout + overlay after 500ms + error toast |
| **Per-Item** | Independent loading spinner per button (delete, restore, etc.) |
| **Pagination** | Server-side cursor-based — fetch only needed data |
| **Search** | Server-side ILIKE with 400ms debounce |
| **UX** | "Load more" button + IntersectionObserver infinite scroll |

---

## Files Created (10)

| File | Purpose |
|---|---|
| `frontend/src/components/navigation-loader.tsx` | Progress bar + navigation context |
| `frontend/src/components/loading-overlay.tsx` | Smooth fade-in/out API overlay |
| `frontend/src/lib/request-tracker.tsx` | Pending count context |
| `frontend/src/hooks/use-server-pagination.ts` | Cursor-based pagination hook |
| `frontend/src/hooks/use-item-loading.ts` | Per-item loading utility |
