# Public share API response boundary

`GET /folders/share/:token` is available without a login. The shared folder root,
its child folders and its child files must **not** be returned as full Prisma rows:
file rows can contain Telegram identifiers, encryption keys and internal storage
state. An optional JWT does not change this public response contract.

- Root: `id`, `name`, `createdAt`, and `user: { username }` only. The query also
  reads `deletedAt` to reject revoked/deleted roots, but does not return it.
- Child folder: `id`, `name`, `createdAt` only.
- Child file: `id`, `filename`, `size`, `mimeType`, `createdAt` only.
- Breadcrumbs remain `{ id, name }`; pagination cursors and `currentFolderId`
  still work. Both paginated and no-pagination branches use the same select
  constants. New Prisma columns are excluded by default.
- A requested folder must be inside the shared root subtree; deleted ancestors,
  a deleted root, or a root without `PUBLIC_LINK` reject access before listing
  children.

`GET /files/share/:token` likewise returns only `id`, `filename`, `size`,
`mimeType`, `createdAt`, `user.username`. It matches a `PUBLIC_LINK`, non-deleted,
complete file; revoked/deleted/incomplete links return 404. Neither route should
expose `shareToken`, `userId`, storage backend identifiers, encryption material,
or future DB columns. Authenticated owner management (`/folders/shared`, share/
unshare mutations) is a separate contract and may need the token for link UI.

When changing the share page, update the explicit select lists and regression
specs together; do not replace a public select with `include` or an unselected
`findMany`. Do not log share tokens in any new request logs.
