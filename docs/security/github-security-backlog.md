# GitHub Security Backlog

This note tracks the November 2026 remediation of GitHub CodeQL and Dependabot
findings.

## Installer findings

- CodeQL alert #47 (`scripts/installer/lib/secrets.mjs`) is fixed by accepting
  random bytes only below `248` before mapping to the 62-character alphanumeric
  alphabet. This rejection sampling avoids modulo bias while preserving the
  40-character Redis/Postgres password contract.
- CodeQL alert #48 (`scripts/installer/index.mjs`) is fixed by keeping the
  database-only installer's `POSTGRES_PASSWORD` in mode-`0600` `.env.db`; the
  value is never printed or copied into `.installer-plan.json`.
- Operators must read the value locally and transfer it to the control-plane
  host through a secure out-of-band channel.

The GitHub alerts close only after this patch reaches the default branch and a
new CodeQL run confirms the vulnerable data flows are gone.

## Dependency handling

Dependabot branches were evaluated by manifest/lockfile lane. Red, conflicted,
or stale bot PRs are replaced by this clean update from current `master`;
security alerts are never dismissed merely to reduce the open count. The old
bot PRs should be closed as superseded only after this branch is merged.

The Go data-plane dependency updates move Echo to `v4.16.3`, gRPC to `v1.83.2`,
and the build image/module directive to Go 1.26. They require `go test ./...`
and `go build ./...`. Backend dependency updates pin patched transitive versions
through npm overrides without upgrading NestJS 11 to 12. The `archiver` runtime
path keeps version 8 but overrides `readdir-glob`'s `minimatch` to 11.0.8, which
removes the production advisory without reverting the ZIP API to archiver 7.
The backend overrides also pin body-parser 2.4.0, fast-uri 3.1.9,
follow-redirects 1.16.2, and multer 2.5.0. Frontend updates pin
follow-redirects 1.16.2 and move Vitest/@vitest-mocker to 5.1.0, which removes
tinypool from the dependency graph.

After the update, `npm audit --omit=dev` reports zero findings for both backend
and frontend. A full audit still reports 19 Low/Moderate development-only
findings on the backend and 7 Moderate development-only findings on the
frontend: Nest CLI/Jest/typescript-eslint on the backend and typescript-eslint
on the frontend. At the time of this change, npm only proposes incompatible
Nest CLI/Jest changes and the published latest typescript-eslint release is
still in the affected range. Do not use `npm audit fix --force`; revisit these
findings when compatible upstream releases are available.

## Verification snapshot

- Backend build passed; 30 suites / 277 tests passed. Full lint still reports
  329 pre-existing issues across the codebase (298 errors and 31 warnings).
- Frontend lint, typecheck, production build, and 15 files / 33 tests passed.
- Go data plane `go test ./...` and `go build ./...` passed.
- Installer test suite passed 64/64 tests.
