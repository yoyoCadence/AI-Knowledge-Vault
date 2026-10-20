# Handoff

The current state of the project, written for an agent or engineer who has no access to earlier
conversations. Update it at the end of every PR.

## 1. Snapshot (2026-10-20, after PR 7: portable export + restore)

**Merged and tested**

- **PR 1, Phase 0:** foundation (docs, toolchain, DB, storage, jobs, shell, CI, Docker).
- **PR 2, P1A-AUTH:** Better Auth, `admin:create`, sessions, `authedRoute`, login/settings UI,
  E2E.
- **PR 3, single-file import pipeline:**
  - schema and the immutability trigger
  - extraction for HTML, Claude Design, MD, TXT/Big5, PDF and images
  - import API and the idempotent worker job
  - version matching, suspected duplicates
  - signed original downloads
- **PR 4, P1A-ZIP + P1A-RECOVERY:**
  - `src/modules/extraction/zip/reader.ts` (`SafeZip`):
    - yauzl's name and size validation
    - plus our own checks: symlinks, encryption, control characters, depth, entry count,
      compression ratio, total and per-entry limits on actual bytes
    - nested archives and duplicate names are listed but never extracted
  - `zip/classify.ts`: Claude Design (`*.dc.html`), static site (common root folder stripped),
    prebuilt framework output (`dist|build|out`), framework source (BUILD_REQUIRED, never built),
    document bundle, unsupported.
  - `zip/process.ts`:
    - entry-document extraction
    - `.thumbnail`/cover → WebP thumbnail
    - the preview-site file list (allowed types only; capped by `PREVIEW_MAX_FILES` and
      `PREVIEW_MAX_TOTAL_BYTES`)
    - `package.json` script _names_ only
  - **Worker:**
    - streams preview files from the ZIP into derived assets, hashing as it goes
    - hostile ZIPs fail with `ARCHIVE_REJECTED`, but their original and an `unsupported`
      version are preserved
  - **`maintenance.cleanup_imports`**, scheduled hourly via `src/worker/scheduler.ts`, one
    idempotency key per hour:
    - expires abandoned uploads
    - reconciles items whose job died
    - deletes staging after retention (24 h; 7 days for failed items), recording
      `staging_cleaned_at`
    - prunes old job rows
  - Migration `0003_import_staging_cleanup`.
  - **Tests:** 157 passing, including 22 ZIP security and classification unit tests and the
    50-item mixed batch (exit criterion 4).
  - **Verified locally on the owner's real Claude Design ZIP** (not committed): classified as
    `claude_design_document`, Traditional Chinese title detected, 31 sections, 39 references,
    `.thumbnail` cover, 7 preview files.

- **PR 5, P1A-IMPORT-UI + library basics:**
  - `/import` page with `ImportWorkspace` (client component):
    - drag and drop or file picker, with extension and size checks
    - bounded parallel direct uploads (3) with progress through XHR
    - `/complete` per file, then report polling every 1.5 s
    - per-file status, outcome, links and errors, with retry for failed items
    - batch options: auto-version by filename, and a source platform
    - recent batches list
  - Library grid (`/`) with cursor paging. Thumbnails come from `GET /api/artifacts/:id/thumbnail`
    (authorized; our own WebP).
  - Artifact detail (`/artifacts/:id`): kind, visibility, summary, outline from the sections,
    the document's references, processing notes, file facts (name, size, SHA-256, status),
    source facts ("未知" when unknown, never guessed), versions with downloads.
  - Worker: optional `WORKER_HEALTH_PORT` (`GET /healthz` on localhost), used by Playwright to
    start the worker in E2E.
  - Fixed: `listBatches` counts were 0 (a correlated subquery bound to the wrong table). It now
    uses a JOIN with GROUP BY, and a regression test covers it.
  - E2E: `tests/e2e/import.spec.ts` (Scenario A end-to-end in a real browser).

- **PR 6, hardening: the 14 Codex review findings on PRs 1–4.** They were never addressed,
  because those PRs were merged as soon as CI went green, before the bot's review arrived.
  **Rule from now on: before merging, wait for the PR's review (or, if the reviewer is
  unavailable, run an independent review) and handle its findings.**
  - Config: `APP_ENV` is required when `NODE_ENV=production`. Before this, a deployment that
    forgot to set it validated as `development` and skipped the https and local-storage checks.
  - Docker: `/app/.data/storage` is created and owned by `vault`.
  - Jobs:
    - A failure in a detached `execute()` (such as `failJob` during a DB outage) is logged and
      no longer becomes an unhandled rejection.
    - Lease recovery returns rows and runs `onFailed` for exhausted jobs at once. Maintenance
      still reconciles as a backstop.
    - `drain()` also recovers leases.
  - Auth:
    - Better Auth's `/get-session`, `/list-sessions`, `/revoke-session(s)` and
      `/revoke-other-sessions` now return 404. They serialized session tokens and bypassed the
      audited `/api/sessions` facade.
    - Audit IPs come from `resolveClientIp` (Better Auth's trusted-proxy resolver), not from the
      leftmost `X-Forwarded-For` entry. This applies to both the auth hook and `requestMeta`.
  - Imports:
    - `refreshBatchStatus` locks the batch row. Before this, two items finishing concurrently
      could leave a batch `processing` forever. There is a test that fails without the lock.
    - The size-mismatch failure now refreshes the batch.
    - `GET /api/imports` honours `limit`/`cursor` and returns `nextCursor`. The shared cursor
      codec, which validates its input, is in `src/app/api/_lib/cursor.ts`.
    - Retry policy (`isRetryable`): an item that already committed a version (a rejected archive
      whose original was preserved) is final. Retry needs the staged bytes. The DTO exposes
      `retryable`, and the UI shows a link to inspect the original instead.
  - ZIP:
    - A lying size in a preview asset, found only while streaming, now rejects the archive and
      keeps the original. Before this, the item failed without its original being linked.
    - Fixed a **worker-crash bug** found while testing this: a preview stream that errored
      before the storage adapter attached its listeners raised an uncaught `'error'`.
    - Cover and `package.json` reads propagate integrity errors instead of swallowing them.
    - An oversized bundled PDF respects `PREVIEW_MAX_TOTAL_BYTES`.
    - A `package.json` `build`/`dev` script marks a source project.
  - **Independent review of PR 5** (Codex was over its usage limit). Fixed:
    - Import UI:
      - Polling no longer stops before a new item in a re-used batch is seen.
      - Client upload errors and progress win over the server's `awaiting_upload`.
      - The idempotency `clientKey` is a short UUID, so file names over about 176 characters
        import.
      - Stale polls are ignored after a retry.
    - A finished batch that gets a new file is reopened (`completeItem`).
    - Keyset cursors carry microsecond timestamps (`src/lib/cursor.ts` and
      `infrastructure/database/keyset.ts`). Before this, rows created in the same millisecond
      as a page's last row were skipped. The library page ignores malformed cursors.
    - Thumbnails are sent `private, no-cache` (revalidated by ETag) instead of `max-age=300`.
    - The worker health server awaits its bind, and EADDRINUSE fails startup cleanly before any
      job is claimed.
  - **Independent review of this PR's own diff.** Fixed:
    - `SafeZip.openStream` now maps yauzl's plain errors (corrupt local header, unsupported
      compression) to `ZipRejectedError`. Before this, reading such an entry for the cover,
      `package.json` or the preview failed the job and lost the original instead of preserving
      it.
    - Import polling no longer drops slow responses. Polls don't overlap, and only a retry
      invalidates older reports.
    - Client upload status wins only while the server still says `awaiting_upload`.
    - Impossible cursor dates (Feb 30, year 0) are rejected instead of reaching Postgres.
  - Tests: 182 passing (157 before), plus E2E 6/6.

- **PR 7, P1A-EXPORT + the core of P1A-RESTORE** (`src/modules/backup/`):
  - `format.ts` (format v1): entry paths, Zod schemas for every JSON file, a strict GNU
    `checksums.sha256` codec, and `README.txt`. `manifest.json` pins the SHA-256 of
    `checksums.sha256`, which covers every other entry.
  - `export.ts` (`writeExport`):
    - streams one workspace (metadata, normalized Markdown with front matter, and originals
      byte for byte) into a ZIP with yazl
    - re-hashes each original while streaming; a corrupt stored object fails the export with
      `ORIGINAL_CORRUPT`
  - `service.ts`:
    - `export_runs` and the `export.create` job (temp file → hash → `ws/{ws}/exports/{id}.zip`)
    - `POST/GET /api/exports`
    - `GET /api/exports/:id/download` (302 to a 5-minute signed URL, audited)
    - 7-day retention, enforced by the hourly `maintenance.cleanup_exports` job
  - `restore.ts` (`restoreArchive`):
    - SafeZip (`RESTORE_*` limits)
    - **every entry is hashed and compared before anything is written**, and the hash in each
      original's path must match its content
    - Zod validation plus referential checks
    - originals are content-addressed (dedup per workspace)
    - one transaction per artifact
    - IDs are kept when free; `skip_existing` or `copy` (new IDs, `（還原副本）`, `origin_ref`)
      when the artifact already exists in the target; new IDs when an ID belongs to another
      workspace
    - the archived Markdown becomes the active extraction (`restore_archive`) right away
  - `reextract.ts`: the `restore.reextract_version` job rebuilds text, sections, thumbnails and
    previews with the **same code as imports**. That code was extracted from `process-item.ts`
    into `src/modules/imports/derive.ts` (`deriveVersionContent`, `saveExtraction`). A failure
    keeps the archived text.
  - CLI: `pnpm backup:export --workspace <slug> --out <file>` and
    `pnpm backup:restore <file> --workspace <slug> [--mode skip_existing|copy]`. Bundled as
    `dist/backup-*.mjs`. A restore writes a `restore_runs` row.
  - UI: the export panel on `/import` (create, progress, download with SHA-256, the
    unencrypted-archive warning).
  - Tests: `tests/integration/backup/roundtrip.test.ts` covers:
    1. seed through the real import pipeline
    2. export, then `sha256sum -c` on the extracted archive
    3. destroy the workspace
    4. restore into an empty storage root with identical IDs, metadata and bytes
    5. re-extraction
    6. `skip_existing` idempotency
    7. `copy`
    8. a tampered original → `CHECKSUM_MISMATCH` with nothing written
    9. a forged checksums file → caught by the manifest
    10. a non-export ZIP → rejected

    Also `exports-api.test.ts` (job, download, workspace isolation, expiry) and E2E (export
    download checksum). The CLIs were smoke-tested on E2E data, including the bundled
    `dist/backup-export.mjs`.

  - Migration `0004_backup_runs`: `export_runs`, `restore_runs`, `integrity_checks`.
  - **Review fixes before merge** (Codex, plus an independent review):
    - Export reads all metadata in one `REPEATABLE READ, READ ONLY` snapshot. Before this, an
      import that committed mid-export could leave a version without its artifact.
    - A stream error or `ORIGINAL_CORRUPT` while exporting an original used to raise an uncaught
      `'error'`, which crashed the worker and left the export hanging. It now fails the export
      cleanly, and the CLI deletes the partial file.
    - In `skip_existing` mode, an id taken by another workspace maps to a deterministic
      per-workspace id (`restore:{ws}:{id}`). A re-run therefore skips instead of duplicating.
    - Existing artifacts get the versions they lack. Version-number conflicts are reported as
      failed.
    - Originals that already have rows are re-verified and re-written if storage lost them
      (`repaired`).
    - Archive filenames are truncated by code point and lone surrogates are replaced. A
      200-character name ending in an emoji used to make the archive unrestorable.
    - Re-extraction uses the import rule for `processing_status`.
    - Id lookups are chunked or done with joins, staying under Postgres's 65,535-parameter
      limit.
    - Tests: `tests/integration/backup/restore-edges.test.ts`. All 5 fail on the pre-fix code.

**Not done or not verified**

- Preview files are stored but **not yet served**. The preview origin route (`/p/:token/*`) is
  P1B-PREVIEW.
- No integrity job yet (P1A-INTEGRITY). Restore is CLI-only (no `/api/restores` or UI yet).
- Export archives are unencrypted (P1A-ENC). The UI and CLI warn about this.
- HTML extraction can join adjacent inline labels without a space. This is cosmetic.
- The S3 adapter has not been verified against real R2.

## 2. How to run

See `AGENTS.md` §5 and `README.md`. In the original development container, Postgres 16 was
started with `service postgresql start`, using role `vault`/`vault` and the databases
`vault_dev`, `vault_test` and `vault_e2e`.

```bash
pnpm db:migrate
ADMIN_EMAIL=me@example.com ADMIN_NAME=Me pnpm admin:create   # prompts for a password
pnpm dev                                                     # then log in at http://localhost:3000/login
pnpm build && pnpm test:e2e                                  # E2E (uses vault_e2e)
```

## 3. Conventions worth knowing

- IDs are app-generated UUIDv7 (`idColumn()`). CHECK enums use `oneOf()`.
- **API routes:**
  - Use `authedRoute({ permission }, handler)` for every authenticated endpoint.
  - Parse bodies with `parseJsonBody(request, ZodSchema)`.
  - Throw `AppError` (`notFound()` for anything outside the workspace).
- **Pages:** call `requirePageActor()` in each page that reads data. Do not rely only on the
  layout, because layouts are not re-run on client navigations.
- **Tests:**
  - Integration helpers live in `tests/integration/helpers/` (`testDb`,
    `createTestWorkspace`, `createTestAdmin`, `signIn`, `actorFromCookie`).
  - Route handlers can be imported and called directly with `Request` objects (see
    `tests/integration/api/sessions-api.test.ts`).

## 4. Next steps (exact)

**PR 8: P1A-INTEGRITY plus restore through the API and UI** (BACKUP_RECOVERY.md §6–7):

1. `src/modules/backup/integrity.ts`, job `integrity.check` (one per workspace; idempotency key
   per run):
   - stream every `file_assets` object and re-hash it
   - `storage_status` → `stored`, `missing` or `corrupt`, plus `integrity_verified_at`. Both
     columns are allowed by the immutability trigger.
   - write an `integrity_checks` row with the counts and failing IDs
2. `POST /api/integrity-checks` and `GET /api/integrity-checks/latest`. Show "last verified" and
   the counts on `/import`. Weekly schedule entry in `src/worker/scheduler.ts`.
3. Restore over HTTP:
   - `POST /api/restores` `{filename, size}` → a `restore_runs` row plus a signed upload to
     `storageKeys.restoreUpload`
   - `POST /api/restores/:id/start` `{mode}` → job `restore.run`, which downloads to a temp
     file and calls `restoreArchive`
   - `GET /api/restores/:id` → the report
   - UI: upload an archive on `/import`, choose a mode, show the report
4. Tests:
   - integrity finds a deleted object (`missing`) and a modified local file (`corrupt`)
   - restore over HTTP end to end
5. Docs: API_CONTRACT status, BACKUP_RECOVERY runbook step 6, task.md, ROADMAP, this file.

**Then Phase 1B:**

- preview origin route `/p/:token/*` (derived files already exist) plus the iframe
- reading mode (safe Markdown renderer)
- CJK search
- organization (projects, collections, tags)
- notes, reading state
- sharing
- ops dashboard
- remaining E2E
