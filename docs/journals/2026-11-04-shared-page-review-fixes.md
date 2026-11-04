# Shared page review fixes — 2026-11-04

## Verified failures

- The header counted loaded rows instead of the API totals.
- The table layout clipped mobile actions; icon-only controls lost their
  accessible names below the `sm` breakpoint.
- Invalid cached user JSON could abort auth restoration before loading finished.
- The dual cursor lost file progress while folder pages continued, causing the
  first file page to be queried again.
- Continuation requests repeated both count queries.
- Revoke and locale changes collapsed already loaded pagination state.

Each behavior was reproduced with a failing regression test before production
code changed.

## Resolution

- Preserve initial server totals in `useShared`, keep translation changes out of
  request callback identity, and reconcile settled revoke mutations locally.
- Render responsive list rows with wrapping actions and localized accessible
  names.
- Validate the cached token/user pair and always finish auth restoration.
- Carry file position or file-complete state inside the opaque folder cursor.
- Add `includeTotals=false` for frontend continuation calls; totals remain on by
  default for compatibility. Totals are not trusted from client-editable cursor
  data.

## Verification

- Frontend: 20 tests, lint, typecheck, and production build passed.
- Backend: 276 tests passed; changed-file lint, focused pagination/DTO tests, and
  production build passed.
- `git diff --check` passed. Live authenticated visual QA was unavailable, so
  responsive behavior is guarded by component DOM/class and accessibility tests.
