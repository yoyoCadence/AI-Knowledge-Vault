# Handoff

The current state of the project, written for an agent or engineer who has no access to earlier
conversations. Update it at the end of every PR.

## 1. Snapshot (2026-10-20, after PR 3: import pipeline slice 1)

**Merged and tested**

- **PR 1, Phase 0:** foundation (docs, toolchain, DB, storage, jobs, shell, CI, Docker).
- **PR 2, P1A-AUTH:**
  - Better Auth with sign-up disabled and database rate limiting
  - `admin:create`
  - sessions API
  - `authedRoute`
  - login and settings UI
  - Playwright E2E with a CI job
- **PR 3, import slice 1** (P1A-FILES, IMPORT-API, IMPORT-WORKER, EXTRACT, VERSION):
  - **Schema:** migration `0001_library_import` for projects, artifacts, versions, file_assets,
    artifact_files, derived_assets, extracted_documents, document_sections, import_batches and
    import_items. Migration `0002_file_assets_immutable` adds the trigger.
  - **`modules/extraction`:** magic-byte sniffing, strict UTF-8 → Big5 decoding, zh-Hant/zh-Hans
    language detection, and extractors for HTML (with Claude Design `{{ }}` stripping), Markdown
    (front matter), text, PDF (unpdf, one section per page) and images (sharp thumbnail).
    Sections carry exact character offsets into the plain text.
  - **`modules/files`:** streamed staging download with SHA-256 and a byte cap, and
    content-addressed conditional storage of originals.
  - **`modules/imports`:** batch, declare (idempotent `clientKey`), complete (enqueues in the same
    transaction), retry, cancel and report, plus a state machine.
  - **Worker handler `import.process_item`:**
    - same-hash duplicate detection under an advisory lock
    - version matching (explicit target, or a distinctive filename stem)
    - suspected duplicates flagged by text hash
    - deterministic UUIDv5 IDs, so retries are idempotent
    - the `onFailed` hook marks the item failed with a user-visible reason
  - **`modules/artifacts`:** list, detail, and audited original download via a 5-minute signed
    URL.
  - **Routes:** `/api/imports/**`, `/api/artifacts/**`, and `/api/storage/local/{upload,download}`
    (token-authorized, byte-capped).
  - **Verified with production builds:** sign-in → upload of the owner's real Claude Design HTML
    and ZIP over HTTP → the bundled worker processes them → the downloaded original's SHA-256
    equals the uploaded file's.

**Not done or not verified**

- ZIP files are preserved, but not analysed yet (`archive_other`, error code
  `ARCHIVE_ANALYSIS_UNAVAILABLE`). P1A-ZIP is next.
- There is no reconciliation for jobs whose lease expired with no attempts left. Their import
  item stays `processing`. The `onFailed` hook covers every other failure path. Fix this in
  P1A-RECOVERY with a maintenance job.
- No staging cleanup job yet: abandoned uploads stay in `ws/*/staging/`.
- There is no upload UI yet (P1A-IMPORT-UI); the API is complete.
- HTML extraction joins adjacent inline elements without a space when the source has no
  whitespace between them (e.g. flex-row `<span>` labels). This is cosmetic.
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

## 4. Next steps (exact): PR 4, P1A-ZIP + P1A-RECOVERY + batch/security tests

1. `src/modules/extraction/zip/reader.ts`: a safe inventory using `yauzl.open(tempPath,
{ lazyEntries: true, strictFileNames: true, validateEntrySizes: true })`.
   - Normalize and validate every path (IMPORT_PIPELINE §4): traversal, absolute paths, drive
     letters, NUL, depth, symlink mode bits and encrypted entries.
   - Count actual bytes while streaming. Enforce the total, per-entry and compression-ratio
     limits, as well as the entry count.
2. `zip/classify.ts`: Claude Design (`*.dc.html` + `support.js`/`_ds`/`.thumbnail`), static
   site, framework source, document bundle, unsupported.
3. In `process-item.ts`, replace `archiveOutcome()`:
   - Extract the allowed preview files into derived assets (`kind = preview_file`, `path` = the
     normalized entry path).
   - Run the HTML/MD/PDF extractor on the entry document.
   - Use the `.thumbnail` or the first image as the thumbnail.
   - Record the inventory summary and external dependencies in `analysis`.
4. Add a `maintenance.reprocess_version` job to upgrade versions created as `archive_other`, and
   a `maintenance.cleanup` job (hourly), which:
   - expires stale `awaiting_upload` items
   - deletes staging objects of terminal items
   - fails items whose job ended `failed`
5. Tests:
   - zip-slip, absolute path, symlink, bomb (ratio and total), entry count, nested archive,
     encrypted entry
   - classification fixtures built in code with `yazl`
   - a 50-item mixed batch (exit criterion 4)
   - cleanup and reconciliation

Then: PR 5 = P1A-IMPORT-UI, PR 6 = export/restore + integrity.
