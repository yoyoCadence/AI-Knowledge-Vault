# Task Board

Status: ✅ done & verified · 🚧 in progress · 📝 todo · ⏸ deferred (reason)
Rule: ✅ only when code, tests and docs are complete and CI is green on `main`.

## Phase 0 — Foundation

| ID         | Task                                                                                | Status | Evidence                                                            |
| ---------- | ----------------------------------------------------------------------------------- | ------ | ------------------------------------------------------------------- |
| P0-DOCS    | Architecture review, ADRs, spec docs, handoff docs                                  | ✅     | `docs/*`, `AGENTS.md`                                               |
| P0-TOOLING | TS strict, ESLint (module boundaries), Prettier, Vitest projects, Playwright pinned | ✅     | `eslint.config.mjs`, `vitest.config.ts`                             |
| P0-ENV     | Zod env validation + `.env.example`                                                 | ✅     | `tests/unit/infrastructure/env.test.ts`                             |
| P0-DB      | Drizzle client, migration runner, identity/workspace/audit/jobs schema              | ✅     | `drizzle/0000_foundation.sql`; applied in integration global setup  |
| P0-STORAGE | StorageAdapter + Local + S3/R2 adapters                                             | ✅     | `tests/integration/storage/*` (S3 suite runs against moto in CI)    |
| P0-JOBS    | Postgres job queue + worker runtime                                                 | ✅     | `tests/integration/jobs/queue.test.ts`                              |
| P0-SHELL   | App shell, zh-TW i18n, theme, Future pages, health API, proxy host routing          | ✅     | manual smoke test + screenshots; E2E arrives in P1B-E2E             |
| P0-CI      | GitHub Actions: format, lint, typecheck, tests (Postgres + moto), build             | ✅     | `.github/workflows/ci.yml`                                          |
| P0-DOCKER  | Dockerfile (web + worker + migrate bundles)                                         | ✅     | CI `docker` job builds the image and runs the worker bundle (PR #1) |

## Phase 1A — Preservation Core

| ID                | Task                                                           | Status  |
| ----------------- | -------------------------------------------------------------- | ------- |
| P1A-AUTH          | Better Auth, admin CLI, login/logout, sessions, rate limit     | ✅      |
| P1A-FILES         | Immutable originals, integrity, download                       | 📝 next |
| P1A-IMPORT-API    | Batches/items API, signed upload, complete/retry/cancel        | 📝      |
| P1A-IMPORT-WORKER | `import.process_item` pipeline                                 | 📝      |
| P1A-EXTRACT       | HTML / Claude Design / MD / TXT / PDF / image extraction       | 📝      |
| P1A-ZIP           | Safe ZIP reader, classification A/B/C/D, derived preview files | 📝      |
| P1A-VERSION       | Version matching + suspected duplicates                        | 📝      |
| P1A-RECOVERY      | Staging cleanup, expiry, reconciliation                        | 📝      |
| P1A-IMPORT-UI     | Upload UI with progress and report                             | 📝      |
| P1A-EXPORT        | Portable export v1                                             | 📝      |
| P1A-RESTORE       | Restore + CLI + round-trip test                                | 📝      |
| P1A-INTEGRITY     | Integrity check job                                            | 📝      |
| P1A-ENC           | Built-in age encryption for exports                            | 📝      |

## Phase 1B — Usable Library

See `docs/ROADMAP.md` (all 📝).
