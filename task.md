# Task Board

Status: ✅ done & verified · 🚧 in progress · 📝 todo · ⏸ deferred (reason)
Rule: ✅ only when code, tests and docs are complete and CI is green on `main`.

## Phase 0 — Foundation

| ID         | Task                                                                                | Status | Evidence                                                                                                                                   |
| ---------- | ----------------------------------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| P0-DOCS    | Architecture review, ADRs, spec docs, handoff docs                                  | ✅     | `docs/*`, `AGENTS.md`                                                                                                                      |
| P0-TOOLING | TS strict, ESLint (module boundaries), Prettier, Vitest projects, Playwright pinned | ✅     | `eslint.config.mjs`, `vitest.config.ts`                                                                                                    |
| P0-ENV     | Zod env validation + `.env.example`                                                 | ✅     | `tests/unit/infrastructure/env.test.ts`                                                                                                    |
| P0-DB      | Drizzle client, migration runner, identity/workspace/audit/jobs schema              | ✅     | `drizzle/0000_foundation.sql`; applied in integration global setup                                                                         |
| P0-STORAGE | StorageAdapter + Local + S3/R2 adapters                                             | ✅     | `tests/integration/storage/*` (S3 suite against moto in CI; `pnpm storage:verify` for a real bucket, R2 not yet verified: needs the owner) |
| P0-JOBS    | Postgres job queue + worker runtime                                                 | ✅     | `tests/integration/jobs/queue.test.ts`                                                                                                     |
| P0-SHELL   | App shell, zh-TW i18n, theme, Future pages, health API, proxy host routing          | ✅     | manual smoke test + screenshots; E2E arrives in P1B-E2E                                                                                    |
| P0-CI      | GitHub Actions: format, lint, typecheck, tests (Postgres + moto), build             | ✅     | `.github/workflows/ci.yml`                                                                                                                 |
| P0-DOCKER  | Dockerfile (web + worker + migrate bundles)                                         | ✅     | CI `docker` job builds the image and runs the worker bundle (PR #1)                                                                        |

## Phase 1A — Preservation Core

| ID                | Task                                                           | Status                                                                               |
| ----------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| P1A-AUTH          | Better Auth, admin CLI, login/logout, sessions, rate limit     | ✅                                                                                   |
| P1A-FILES         | Immutable originals, integrity, download                       | ✅                                                                                   |
| P1A-IMPORT-API    | Batches/items API, signed upload, complete/retry/cancel        | ✅                                                                                   |
| P1A-IMPORT-WORKER | `import.process_item` pipeline                                 | ✅                                                                                   |
| P1A-EXTRACT       | HTML / Claude Design / MD / TXT / PDF / image extraction       | ✅                                                                                   |
| P1A-ZIP           | Safe ZIP reader, classification A/B/C/D, derived preview files | ✅                                                                                   |
| P1A-VERSION       | Version matching + suspected duplicates                        | ✅                                                                                   |
| P1A-RECOVERY      | Staging cleanup, expiry, reconciliation                        | ✅                                                                                   |
| P1A-IMPORT-UI     | Upload UI with progress and report                             | ✅                                                                                   |
| P1A-HARDEN        | 14 review findings on PRs 1–4 (auth, jobs, imports, ZIP)       | ✅                                                                                   |
| P1A-EXPORT        | Portable export v1 (job, API, UI, CLI)                         | ✅                                                                                   |
| P1A-RESTORE       | Restore core, CLI, re-extraction, round-trip, API and UI       | ✅                                                                                   |
| P1A-INTEGRITY     | Integrity check job, API, panel, weekly schedule               | ✅                                                                                   |
| P1A-ENC           | Built-in age encryption for exports                            | ✅ encrypted download, sidecar, restore refusal (PR 24); CLI encrypt/decrypt (PR 25) |

## Phase 1B — Usable Library

| ID                | Task                                                               | Status                                                                                                                                                    |
| ----------------- | ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1B-LIBRARY       | Library grid with thumbnails, kinds, source, pagination            | ✅ grid + cursor paging (PR 5); categories (PR 15); recent, favorites, reading status (PR 16); counts and preservation state (PR 22); list layout (PR 23) |
| P1B-DETAIL        | Artifact detail: metadata, outline, references, versions, download | ✅ title, description, project (PR 14); visibility (PR 17, share panel); source metadata (PR 19)                                                          |
| P1B-VERSION-SPLIT | Split a wrongly matched version into its own artifact              | ✅ (PR 21)                                                                                                                                                |
| P1B-PREVIEW       | Preview origin route, preview token API, sandboxed iframe          | ✅ (PR 10)                                                                                                                                                |
| P1B-READER        | Reading mode: allow-list renderer, content API, TOC, read/preview  | ✅ (PR 11)                                                                                                                                                |
| P1B-SEARCH        | CJK keyword search: tokenizer, chunks, index jobs, API, library UI | ✅ search, snippets, backfill (PR 12); tag filter (PR 13); project/kind/model/date filters, sort, total (PR 14); collection filter (PR 15)                |
| P1B-TAGS          | Tags: schema, API, detail editor, /tags page, filters, export v2   | ✅ (PR 13)                                                                                                                                                |
| P1B-PROJECTS      | Research projects: API, /projects page, detail editor, filter bar  | ✅ (PR 14)                                                                                                                                                |
| P1B-ORG           | Collections (hierarchy), export format v3                          | ✅ (PR 15)                                                                                                                                                |
| P1B-NOTES         | Notes and reading state (recent, favorites), export format v4      | ✅ (PR 16)                                                                                                                                                |
| P1B-SHARE         | Share links: check, create, list, revoke, public reader            | ✅ (PR 17)                                                                                                                                                |
| P1B-E2E           | E2E of the main flows, desktop and phone                           | ✅ flows in each feature PR; phone viewport (PR 20)                                                                                                       |
| P1B-OPS           | Usage and status page: storage, DB, jobs, failures, backup state   | ✅ (PR 18)                                                                                                                                                |
| P1B-SKIN          | Full-page "archive" skin (default) with a switch to the plain look | ✅ (PR 27; docs/THEME.md)                                                                                                                                 |
| P1B-DELETE        | Delete an artifact (soft) and undo; deleted works page (ADR-017)   | ✅ (PR 29)                                                                                                                                                |
| others            | see `docs/ROADMAP.md`                                              | 📝                                                                                                                                                        |

## Quality pass (2026-11)

Baseline on `main` at `4a0c8f5` before any change: format, lint, typecheck, 519 unit and
integration tests (2 skipped), build and E2E 16/16 all pass. Classes: **bug** (reproduced),
**gap** (documented as planned, not built), **risk** (documented, unbounded), **checked**
(investigated and found correct; no change).

| ID    | Finding                                                                                                                                                                                                         | Class   | Status                 |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | ---------------------- |
| QP-1  | `filename*` left `'()*` raw. Chromium ignores a `filename*` holding `'` and saves under the ASCII fallback, so "報告's.md" downloaded as "\_\_'s.md" (reproduced in Chromium)                                   | bug     | ✅ PR 28               |
| QP-2  | No way to delete an artifact: nothing sets `artifacts.deleted_at` (ADR-017; API_CONTRACT lists DELETE and restore as planned)                                                                                   | gap     | ✅ PR 29               |
| QP-3  | Search has no `statement_timeout` (HANDOFF "Not done")                                                                                                                                                          | risk    | ✅ PR 30               |
| QP-4  | The empty library said import was unfinished ("匯入功能完成後…") and to drag files onto a page with no drop target                                                                                              | bug     | ✅ PR 29               |
| QP-5  | A failed request showed the browser's English "Failed to fetch" (or "network error" on uploads), and an expired session said "try again" (reproduced offline and with cookies cleared)                          | bug     | ✅ PR 31               |
| QP-6  | A failed sign-out (server error, dropped connection) sent the user to /login, which bounced them back into the library still signed in, with nothing said; offline it also threw an uncaught error (reproduced) | bug     | ✅ PR 31               |
| QP-7  | The import report showed a raw code and the server's English text as a file's failure reason ("UNSUPPORTED_FILE_TYPE：The file content is not a supported format")                                              | bug     | ✅ PR 32               |
| QP-c1 | Promise handling: a one-off type-aware lint (`no-floating-promises`, `no-misused-promises`) found only `try`/`catch`-wrapped interval callbacks                                                                 | checked | no change              |
| QP-c2 | Version split vs. share previews: a token for a moved version stops (`shareAllowsPreview` requires the link artifact's current version)                                                                         | checked | no change              |
| QP-c3 | Import dedupe and version matching skip deleted artifacts, so a soft delete cannot swallow a re-import                                                                                                          | checked | no change              |
| QP-c4 | Every page on desktop and phone, both skins, light and dark, plus not-found pages: no console or hydration errors, no broken layout                                                                             | checked | no change              |
| QP-c5 | Preview root-relative URLs: previews run with `script-src 'none'` (ADR-007), so framework builds cannot render anyway; a deliberate trade-off                                                                   | checked | no change (documented) |
