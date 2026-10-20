# Handoff

The current state of the project, written for an agent or engineer who has no access to earlier
conversations. Update it at the end of every PR.

## 1. Snapshot (2026-10-20, after PR 4: ZIP pipeline + recovery)

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
    `claude_design_document`, title 「胚胎沒有藍圖，只有規則」, 31 sections, 39 references,
    `.thumbnail` cover, 7 preview files.

**Not done or not verified**

- No upload UI and no library UI yet. Both the import API and the artifact API are complete.
- Preview files are stored but **not yet served**. The preview origin route (`/p/:token/*`) is
  P1B-PREVIEW.
- No export, restore or integrity job yet (P1A-EXPORT, P1A-RESTORE, P1A-INTEGRITY).
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

**PR 5: P1A-IMPORT-UI + a minimal library listing.**

1. `src/app/(dashboard)/import/page.tsx`, replacing the FutureFeature placeholder:
   - a client `ImportDropzone` (drag and drop plus a file picker)
   - per file: `POST /api/imports/:batch/items` → `PUT upload.url` with progress via
     `XMLHttpRequest.upload.onprogress` → `/complete`
   - at most 3 parallel uploads
   - poll `GET /api/imports/:batch` every 1.5 s until no item is `queued` or `processing`
   - a report table with status, outcome, errors and warnings, a retry button for failed items,
     and links to result artifacts
2. Recent batches list (`GET /api/imports`).
3. Library page: cards from `listArtifacts` (title, kind badge, source platform, date,
   thumbnail via a new authorized route `GET /api/artifacts/:id/thumbnail`), plus an empty
   state with an import link.
4. E2E: log in → upload 3 fixtures (HTML, ZIP, a broken file) → see the report → open the
   library and find the cards.

**PR 6: P1A-EXPORT + P1A-RESTORE + P1A-INTEGRITY.** See BACKUP_RECOVERY.md (format v1,
round-trip test, tamper test).
