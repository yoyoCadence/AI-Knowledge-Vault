# Handoff

The current state of the project, written for an agent or engineer who has no access to earlier
conversations. Update it at the end of every PR.

## 1. Snapshot (2026-10-27, after PR 20: phone viewport)

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

- **PR 8, P1A-INTEGRITY** (`src/modules/backup/integrity.ts`):
  - The `integrity.check` job re-hashes every original in a workspace (in pages, with progress)
    and sets `file_assets.storage_status` to `stored`, `missing` or `corrupt`. Verified files
    also get `integrity_verified_at`.
  - It writes an `integrity_checks` row with the counts and up to 1,000 failing IDs.
  - Only one check can be pending per workspace (the workspace row is locked).
  - `POST /api/integrity-checks` and `GET /api/integrity-checks/latest`.
  - A weekly `maintenance.schedule_integrity_checks` run queues one check per workspace.
  - UI: an integrity panel on `/import` (last result, counts, damaged files, "立即檢查").
  - Tests: `tests/integration/backup/integrity.test.ts` (all OK, then a deleted object →
    `missing`, rewritten bytes → `corrupt`, workspace isolation) and an E2E step.

- **PR 9, P1A-RESTORE through the API and UI** (`src/modules/backup/restore-runs.ts`):
  - `POST /api/restores` `{filename, size}` (owner only, `backup:restore`): creates a
    `restore_runs` row (migration `0005_restore_upload`, which adds `source_filename` and
    `source_byte_size`) and returns a signed upload to `storageKeys.restoreUpload`. Archives
    are capped at `RESTORE_MAX_ARCHIVE_BYTES` (5 GiB).
  - `POST /api/restores/:id/start` `{mode}`: checks the uploaded size and queues `restore.run`.
    Idempotent; returns 409 before the upload exists.
  - The `restore.run` job downloads the archive, records its SHA-256, runs `restoreArchive`,
    stores the report, and deletes the uploaded archive. An invalid archive
    (`CHECKSUM_MISMATCH`, wrong format) fails the run with its details and writes nothing.
  - Retry and timeout safety (Codex review of PR 9): copy mode derives every new id from the
    run (`restore-copy:{restoreId}:{oldId}`), so a retried attempt resumes instead of copying
    again. The job's abort signal reaches `restoreArchive`, and the final status write only
    applies while the run is `running`. `source_storage_key` is cleared only after the upload
    is deleted and its signed URL has expired (replay window); the hourly
    `maintenance.cleanup_exports` job finishes failed deletions, re-deletes replayed uploads,
    and abandons runs never started within 24 hours (`cleanupRestoreUploads`). The panel
    retries a lost `/start` on the run it already uploaded to.
  - `GET /api/restores` and `GET /api/restores/:id`. Requests and starts are audited.
  - UI: a "從備份還原" panel on `/import`. Choose a file and a mode (each mode is explained),
    see upload progress, then the report: counts, warnings, failures, and "nothing written" on
    verification failures.
  - Tests: `tests/integration/api/restores-api.test.ts` (end to end, idempotent start, tampered
    archive → `CHECKSUM_MISMATCH` with nothing written, start before upload, oversize, workspace
    isolation, an aborted attempt stops writing, a late attempt cannot overwrite its timeout
    failure, failed deletions are retried, abandoned uploads are cleaned up) and
    `roundtrip.test.ts` (a retried copy-mode run duplicates nothing). The E2E test now restores
    the archive it just exported through the UI (`略過 2`).

- **PR 10, P1B-PREVIEW** (`src/modules/preview`, SECURITY.md §5):
  - `POST /api/artifacts/:id/versions/:versionId/preview-token` returns `{url, expiresAt}`, a
    15-minute URL `PREVIEW_ORIGIN/p/<token>/<entry path>`. The token is an HMAC path token
    (`signToken`, purpose `preview`, claims `v` version, `w` workspace, `s` scope `owner`).
    404 when the version has no servable preview.
  - `src/app/p/[token]/[...path]/route.ts` serves `derived_assets` `preview_file` rows.
    - It re-checks the Host (defense behind `proxy.ts`).
    - It decodes the raw path segments exactly once and refuses `.`/`..`, encoded `/` or
      `\`, control characters and bad encoding. No filesystem is involved; the path is only a
      lookup key.
    - It serves only while the artifact is not deleted and the version's preview is `ready`,
      even for live tokens.
    - Headers: the CSP from SECURITY.md §5.4 (`sandbox allow-same-origin` except PDFs), and
      `.js`/`.mjs` as `text/plain`. Also nosniff, `no-referrer`, ETag/304. No charset is
      declared, so Big5 documents keep their own `<meta charset>`.
    - Every refusal is the same bare 404; a row whose object is missing is a 404 plus a
      warning log. `proxy.ts` refuses malformed percent-encoding on the preview host.
    - `HEAD` answers from the manifest without opening the object.
    - Only `static_html`/`static_site` versions get a URL. A ZIP holding only a PDF is
      `pdf`, which a `sandbox=""` frame cannot show.
  - `next.config.ts` global headers exclude `/p/*`: `X-Frame-Options: DENY` and the app's
    Referrer-Policy would otherwise clash with the preview headers.
  - Detail page: a "安全預覽" card with a `PreviewFrame` client component.
    - The iframe uses `sandbox=""` and `referrerPolicy="no-referrer"`.
    - "重新載入" mints a new token. The "在新分頁開啟" link is re-minted in the background
      before it expires; refreshes use the server's `expiresInSeconds` on the browser's own
      clock (a wrong clock cannot cause a busy loop), never run more often than every 10 s,
      and back off on failure. When the frame's own token expires, a notice asks the user to
      reload.
    - Versions without a preview get an honest notice: pending, failed, framework source,
      unavailable, or "reading mode later" for PDF/image/text.
  - Tests:
    - `tests/unit/preview/preview.test.ts`: token round trip, tamper, foreign secret, wrong
      purpose, bad claims; path normalization; content types; CSP.
    - `tests/unit/proxy.test.ts`: host isolation.
    - `tests/integration/api/preview-api.test.ts`: issue and serve, relative resources,
      304, HEAD, a 12-case refusal matrix (tamper, expiry, cross-version, cross-workspace,
      encoded traversal, NUL, app host), the `kind` filter, a missing object, a PDF-only
      ZIP, deleted artifact, no-preview and stranger → 404, CSRF.
    - An independent review of the preview diff found 5 bugs, all fixed with tests: a refresh
      busy-loop on fast client clocks, a forced UTF-8 charset, an iframe offered for a
      PDF-only ZIP, a silent frame-token expiry, and a 1-in-16 flaky tamper test.
    - E2E: the Claude Design ZIP renders in the cross-origin sandboxed frame, a planted script
      does not run, `support.js` is served as `text/plain`, and `/p/*` returns 404 on the app
      host.

- **PR 11, P1B-READER** (`src/components/reader/markdown-view.tsx`, SECURITY.md §5):
  - `MarkdownView` parses our normalized Markdown (mdast with GFM) and renders it through an
    allow-list into React elements. Raw HTML is shown as escaped text, and only
    `http(s)`/`mailto`/`#` links remain links (external ones with
    `noopener noreferrer nofollow`). Images show their alt text and load nothing.
    `PlainTextView` shows `text` extractions as written.
  - Root-level headings take the stored section anchors in order, so the outline links work
    for HTML, Claude Design, Markdown and PDF (`page-N`). A unit test runs the real
    extractors and checks that every anchor exists in the rendered output.
  - `GET /api/artifacts/:id/versions/:versionId/content` (`getVersionContent`).
  - Detail page: a server-driven `?view=read|preview` switch. Sites open on the preview,
    everything else on reading mode. Outline entries link to `?view=read#anchor`. Image
    versions show their thumbnail, and PDFs carry a note that layout and images are only in
    the original.
  - Lint: a reader-only `no-restricted-syntax` rule bans `dangerouslySetInnerHTML` and
    `innerHTML`/`outerHTML` assignment, on top of the global `react/no-danger`.
  - Tests: `tests/unit/reader/markdown-view.test.ts` (raw HTML inert, link allow-list, no
    image loads, structure, anchors only at root, plain text, anchor alignment across
    extractors), `tests/integration/api/content-api.test.ts`, and an E2E reading step
    (switch tab, heading rendered, no script/iframe/img in the reader, outline link jumps to
    its anchor).

- **PR 12, P1B-SEARCH** (`src/modules/search`, docs/SEARCH_DESIGN.md):
  - `tokenizer.ts` (`TOKENIZER_VERSION = 1`):
    - NFKC plus lower-case;
    - CJK runs become bigrams and unigrams at consecutive positions; words stay whole;
    - one position per separator run, so phrases never cross punctuation;
    - output is a `tsvector` literal.
    - Queries: CJK runs become `<->` bigram phrases, words become prefixes (`:*`), quoted
      text becomes an exact phrase, at most 16 terms. Lexemes are only `\p{L}\p{N}`, so
      input cannot inject tsquery syntax.
    - Fields of one vector sit 100 positions apart, so phrases never cross fields.
  - `chunks.ts`: chunks follow sections, at most 1,200 characters, split at paragraph or
    sentence ends with a 100-character overlap, with exact plain-text offsets. Cuts never
    split a surrogate pair.
  - Migration `0006_search_index`: `content_chunks`, `artifact_search_documents` (GIN
    indexes) and `search_index_states`.
  - `indexer.ts`:
    - `saveExtraction` enqueues `search.index_version` in its own transaction. A restored
      version without archived text is queued by version id, for its metadata.
    - The job replaces a version's chunks, records the state it built them from, and
      rebuilds its artifact's metadata document under the artifact row lock.
    - `search.reindex_all` (daily) queues versions whose recorded state does not match
      their active extraction and tokenizer, and artifacts without a metadata document.
  - `query.ts`: one parameterized query matches each term separately and keeps artifacts
    where every term matched in some chunk of the current version or in the metadata
    document (AND per artifact, not per chunk). Workspace-scoped, deleted excluded.
    Snippets are `{text, highlight}` segments from the best chunk. The per-artifact AND is
    a single aggregation over the hits. An earlier shape joined back onto a HAVING result;
    the planner estimated it at one row and chose nested loops, so a very common term took
    13 s at 60,000 chunks. Now it takes about 0.18 s at 60,000 and 0.4 s at 120,000 chunks
    (local Postgres 16, 20 chunks per artifact, every chunk matching).
  - Index job lock order: version row, then its artifact row, before any chunk is written.
    A chunk's foreign key takes a key-share lock on the artifact, so two jobs for versions
    of one artifact used to deadlock. A deterministic test reproduces the old deadlock.
  - Metadata fields are capped before indexing (title 500, description and summary 5,000
    each, source fields 500 characters). An unbounded description could exceed Postgres'
    1 MB tsvector limit and fail the whole index job every day.
  - Lint: backslashes are banned in `sql` templates (the tag drops them, which had silently
    turned the old backfill regex `'\S'` into `'S'`).
  - Pages read repeated search parameters (`?q=a&q=b`) by their first value
    (`src/lib/search-params.ts`) instead of crashing.
  - `GET /api/search?q&offset`; library page `/?q=` with a plain GET form (works without
    JS), results with `<mark>` highlights, linking to reading mode.
  - Tests:
    - `tests/unit/search/*`: tokenizer (positions, normalization, phrases, injection
      safety, term cap), chunker (offsets, boundaries, overlap, progress) and snippets
      (full-width, word-start prefixes, truncation).
    - `tests/integration/search/search.test.ts`: 2-character word; contiguous 4-character
      phrase where every bigram also occurs apart; prefix, full-width, mixed and quoted
      phrase; summary; snippet; workspace isolation; deleted artifact; current version
      only; backfill; AND across description/body and across sections; no phrase across
      metadata fields; title-over-body ranking; state-based backfill (own job never ran;
      no extraction); metadata built from the version current at commit (row lock).
    - `roundtrip.test.ts`: a restore queues an index job for every restored version.
    - Test infrastructure: `uniqueIp()` is now random. The old per-file counter restarted in
      every file while rate-limit buckets live in the database for the whole run, so a
      file's 4th sign-in could hit the bucket `auth.test.ts` exhausts on purpose. That gave
      a 429 sign-in and a stray 401, seen twice in `imports-api.test.ts`; it could not be
      reproduced in 13 further full runs. Tests that need a session now use `signInOk`,
      which fails with the sign-in status and body instead of a later 401.
    - `tests/integration/api/search-api.test.ts`.
    - E2E: Chinese search with a highlighted hit.
    - Adjacency, current-version, deletion and workspace filters were each mutation-checked,
      and so was every fix from the independent review (per-artifact AND, field gap, row
      lock, state backfill, no-extraction metadata, restore enqueue, surrogate-safe cuts,
      word truncation).

- **PR 13, P1B-TAGS** (`src/modules/tags`, DATA_MODEL §4.4, API_CONTRACT §6, ADR-018):
  - Migration `0007_tags`: `tags` (display `name`, `normalized_name` unique per workspace,
    1–50 characters) and `artifact_tags`. Its foreign keys are composite
    (`(workspace_id, artifact_id)`, `(workspace_id, tag_id)`), so the database refuses a
    cross-workspace link. The generated SQL had to be reordered by hand: the
    `artifacts(workspace_id, id)` unique constraint must exist before the foreign key that
    references it.
  - `src/modules/tags`: `normalizeTagName` (NFKC, case, spacing, zero-width characters),
    `ensureTag` (create or reuse by normalized name), `renameTag` (409 with the other tag's
    id on a taken name), `mergeTag`, `deleteTag`, `setArtifactTag`, `listTags` (counts
    exclude deleted artifacts). Every change re-indexes the affected artifacts' metadata in
    the same transaction, in id order. Audit events carry ids only.
  - Search: tag names are metadata (weight B, one field per tag); `tag` filter in
    `searchArtifacts` and `/api/search`; `listArtifacts` and `/api/artifacts` take `tag` and
    return each card's `tags`; `/api/artifacts/:id` returns `tags`.
  - API: `/api/tags` (GET, POST), `/api/tags/:id` (PATCH, DELETE), `/api/tags/:id/merge`,
    `/api/artifacts/:id/tags/:tagId` (PUT, DELETE).
  - UI: tag editor on the detail page (add by name with suggestions, remove, chips link to
    `/?tag=`), tags on library cards, library tag filter (also inside search), `/tags` page
    (rename, merge, delete with a second-click confirm), nav item. Viewers see tags
    read-only.
  - Export format v2 (`tags.json`, `artifact_tags.json`; ADR-018). Restore reads v1 and v2,
    validates tag names and links, merges tags by name, and writes tag links only with
    newly restored artifacts. The restore panel shows tag counts.
  - Tests: unit (`normalizeTagName`); integration `tests/integration/tags/tags.test.ts`
    (normalization, idempotent add/remove, workspace isolation including the database
    guard, rename/merge/delete with search following, counts, filters, audit without
    names); `tests/integration/api/tags-api.test.ts` (status codes, 409 details, viewer 403,
    CSRF); round trip with tags (clean restore, skip_existing, copy merges, v1 archive still
    restores, inconsistent tag metadata refused, unknown version refused); E2E tags an
    artifact, follows the tag, searches by it, checks `/tags`, and sees the tag merged on
    restore. Re-indexing, merge conflict handling, the search filter, tag metadata and
    restore links/merging were mutation-checked.
  - Independent review (Codex was out of credits) found, and this PR fixes, each with a
    test that fails without the fix:
    - Tag writes deadlocked on a shared artifact: a link's foreign key takes a key-share
      lock before the metadata re-index locks the artifact for update. Tag operations now
      lock their artifacts first (order: tags, then artifacts by id); concurrency test.
    - Restore failed for good when two archived tags mapped to one target tag (duplicate
      link): links are de-duplicated and inserted with `on conflict do nothing`.
    - Restore dropped archived links of existing artifacts without a word: now counted and
      warned about. Resumed copy-mode tags count as `copied`, like artifacts.
    - Tag names that render as nothing (ZWJ, soft hyphen, Hangul filler) or contain
      bidirectional controls are refused.
    - `ensureTag` and the restore's tag lookup retry instead of failing on a row renamed or
      deleted between the insert and the select (not reproducible in tests; defensive).
  - A second review of those fixes found, and this PR fixes, each with a test that fails
    without the fix:
    - Restore inserted links in archive order and could deadlock with a tag merge: it now
      locks the target tags `FOR KEY SHARE` in id order first (deterministic test with a
      blocking connection).
    - A tag deleted mid-restore failed the whole artifact: its link is now dropped and
      counted (`artifactTagsDropped`; deterministic test).
    - Report counts: `artifactTagsKept` counts only archived links the existing artifact
      lacks (an unchanged re-restore reports nothing); a resumed copy counts its links.
    - Names: identity drops default-ignorable characters and blank glyphs (no look-alike
      tags); directional marks are dropped instead of refusing Hebrew or Arabic names.
    - `deleteTag` locks artifacts before the cascade; `setArtifactTag` re-checks the
      artifact after locking it; `lockArtifacts` is one statement.

- **PR 14, P1B-PROJECTS and the filter bar** (`src/modules/projects`,
  `src/modules/artifacts/{edit,filters}.ts`, API_CONTRACT §5–§7):
  - Projects: list with artifact counts, create, rename, describe, archive or unarchive,
    soft delete (artifacts keep their reference and show no project; a deleted project
    filters to nothing). `/api/projects`, `/api/projects/:id`; `/projects` page; nav item.
  - `PATCH /api/artifacts/:id {title?, description?, projectId?}`: workspace-scoped, the
    artifact row locked, the project checked live and in the workspace, search metadata
    re-indexed in the same transaction, audited by field name only. Detail page: an
    "作品資訊" card shows the project (a link to the filtered library) and the description,
    and lets editors change title, description and project.
  - Filters, one builder for the library list and search: tag, project, kind, source model
    (the current version's), import day range (Asia/Taipei days). Library sort newest or
    oldest (keyset cursor in both directions); search sort relevance, newest or title, and
    `total`. The library page has one GET form (search box plus a "篩選與排序" panel), so
    every view works without client JavaScript and has a shareable URL.
  - Independent review (Codex out of credits) found, and this PR fixes, each with a test that
    fails without the fix: year-0000 dates and a NUL in `model` were 500s (now 400 from the
    API, ignored by the page); project descriptions were not validated (titles and
    descriptions now share `src/lib/text.ts`, which also refuses invisible or bidi-spoofed
    titles and C0/C1 controls); the source-model filter trimmed while stored values keep
    spaces (now exact); a deleted project's id still showed on artifacts (now null); the
    editor re-sent an untouched description with CRLF line endings; project errors quoted
    the artifact limits.
  - Codex review of the PR found, and this PR fixes, each with a test that fails without the
    fix: project counts joined artifacts by project id only, so a cross-workspace reference
    (possible only by writing to the database directly; `artifacts.project_id` is not a
    workspace-scoped key) leaked into another workspace's count; titles and descriptions kept
    the directional marks LRM, RLM and ALM, which are now stripped (as in tag names). Not
    changed: the search heading shows no count for zero results, where the page already says
    "no results".
  - Tests: `tests/integration/projects/projects.test.ts` (CRUD, scoping, soft delete, counts,
    project assignment and filters, edit with re-index, every filter, both sorts with the
    cursor, search filters, sort and total), `tests/integration/api/projects-api.test.ts`
    (status codes, validation, unknown fields, viewer 403, other workspace 404); E2E creates
    a project, assigns the artifact on its page, follows the project, and filters by kind.

- **PR 15, P1B-ORG: collections** (`src/modules/collections`, migration `0008_collections`,
  DATA_MODEL §4.4, API_CONTRACT §6, BACKUP_RECOVERY §2 and §6):
  - A tree of categories and collections per workspace (at most 7 levels); an artifact can
    be in many. Sibling names are unique as the app compares them; the database enforces it
    (`unique(workspace_id, parent_id, normalized_name)` NULLS NOT DISTINCT) and keeps parents
    and items inside the workspace with composite foreign keys. Cycles and depth are checked
    in code under a per-workspace advisory lock taken by every change of the tree's shape
    (create, move, delete, restore); a deterministic test shows two concurrent moves cannot
    close a cycle. A collection with subcollections cannot be deleted (409 `HAS_CHILDREN`).
  - API: `/api/collections` (GET tree, POST), `/api/collections/:id` (PATCH rename, kind,
    description, move; DELETE), `/api/collections/:id/items/:artifactId` (PUT, DELETE);
    `GET /api/artifacts/:id` lists the artifact's collections with their paths;
    `POST /api/imports {collectionId}` puts new artifacts of the batch in a collection
    (`import_batches.target_collection_id` now has its foreign key, `ON DELETE SET NULL`).
  - Filter: `collection` on the library and search (API and page) includes the subtree. The
    filter panel has an indented collection picker, and an active collection filter has its
    own line with a "clear" link.
  - UI: `/collections` replaces its placeholder (create at the top or under a parent, rename,
    change kind, describe, move, delete); the detail page has a "分類與集合" card (add with an
    indented picker, remove; paths link to the filtered library).
  - Export format v3 (`collections.json`, `collection_items.json`); restore reads v1–v3.
    Collections merge by place and name like tags, parents first, each insert under the tree
    lock with the parent and depth re-checked. One that cannot be placed is reported, with
    its subtree, and the rest goes on; items follow the tag-link rules (`collectionItems`,
    `collectionItemsKept`, `collectionItemsDropped`). Verification refuses unknown parents,
    cycles, trees deeper than 7 levels, invalid or duplicate sibling names, and dangling or
    duplicate items before anything is written.
  - Codex review found, and this PR fixes, each with a deterministic test that fails without
    the fix: an add could link an artifact soft-deleted meanwhile (it now locks and re-checks
    the artifact, as tag links do), and concurrent adds to one collection (parallel imports)
    could get the same position (the collection is now locked `FOR NO KEY UPDATE` first).
  - An independent review found, and this PR fixes, each with a test that fails without the
    fix: a crafted archive could fail a restore half-way (a NUL anywhere in the metadata, year
    0 dates, an int4-overflowing sort order or position) or restore a collection description
    the app refuses, which then blocked every edit of it; an archived position near the int4
    limit broke later adds; a collection deleted while a batch was created gave a 500 (now
    404). Also: the edit form sends only changed fields, collection errors name collections,
    a refused delete asks for confirmation again, and `max(position)` uses an index. Not
    changed: older archives' project and artifact texts are restored as they are (projects
    made before PR 14 were never validated, so refusing them would refuse real backups).
  - Tests: `tests/integration/collections/collections.test.ts` (tree, names, cycles, depth,
    items, subtree filter in library and search, delete rules, isolation, import into a
    collection, concurrent moves), `tests/integration/collections/collections-restore.test.ts`
    (merge by name, a branch too deep to merge, a collection deleted mid-restore),
    `tests/integration/api/collections-api.test.ts`; the round trip covers v3 exactly, v2
    and v1 archives, and seven kinds of broken collection metadata; E2E creates a category
    and a subcollection, adds the artifact on its page, and filters by the category. The
    guards were mutation-checked: removing the tree lock, the cycle check, a depth check, the
    import step, the subtree recursion, the restore's depth check, its live-collection check
    or its merge by name each fails a test.

- **PR 16, P1B-NOTES: notes and reading state** (`src/modules/notes`, migration
  `0009_notes_reading_state`, DATA_MODEL §4.4, API_CONTRACT §5–§7, BACKUP_RECOVERY §2 and §6,
  ADR-019):
  - Notes: Markdown on an artifact (1–20,000 characters, the description text rules), listed
    newest first with the author, shown with the reading mode's allow-list renderer (never as
    HTML), editable and deletable by editors, and searchable: each write locks the artifact
    first, then writes and re-indexes it in the same transaction (notes are metadata weight C,
    newest first, up to 20,000 characters in all). API: `GET/POST /api/artifacts/:id/notes`,
    `PATCH/DELETE /api/notes/:id`.
  - Reading state, per user: unread / reading / read, favorite, last opened. Opening the
    detail page records it from the browser (a link prefetch never counts) and moves unread to
    reading; the page has a favorite button and a status picker. API: `GET/PUT
/api/artifacts/:id/reading-state` (`library:read`: viewers keep their own state).
  - Library: "全部作品 / 最近開啟 / 我的收藏 / 未讀" shortcuts, a status filter and a favorite
    checkbox in the filter panel (library and search), `sort=opened` with its own keyset
    cursor, and a star and status badge on cards.
  - Export format v4 (`artifact_notes.json`, `artifact_reading_states.json` with one state
    per artifact merged over members); restore reads v1–v4, writes notes with new artifacts,
    adds the notes an existing artifact lacks (like versions), and gives the restoring user
    the archived reading state of newly restored artifacts (ADR-019).
  - Tests: `tests/integration/notes/notes.test.ts` (CRUD and search, text rules, isolation
    and deleted artifacts, the note-length cap, a deterministic two-writers deadlock test,
    per-user state, filters, recently opened with the cursor, the merged export),
    `tests/integration/api/notes-api.test.ts`; the round trip covers v4 exactly, a lost note
    coming back and being searchable again, copy mode, v3/v2/v1 archives and broken note and
    state metadata; E2E writes a note (Markdown rendered, a `<script>` shown as text), marks a
    favorite and "read", and follows the favorites and recently-opened views and search.
    Mutation-checked: the artifact lock before a note write, note indexing, its cap and
    newest-first order, the per-user filter, the open transition, the opened cursor, the
    merged export.
  - Codex review found, and this PR fixes, with tests that fail without the fix: a note long
    enough to reach the tsvector's last position (16,383) made later phrases unsearchable,
    the source fields included. Tokens past it are now left out instead of clamped, and notes
    come last in the metadata document. (Its other finding, emoji notes refused on restore,
    does not reproduce: zod 4.6 counts code points; a round-trip test pins it.)
  - An independent review found, and this PR fixes, each with a test that fails without the
    fix: a note of deeply nested Markdown stalled the server for up to a minute or crashed
    the page (notes now pass Markdown cost limits on write and restore, and the renderer
    falls back to plain text, SECURITY.md §5); an artifact with ~9,400 notes could not be
    restored (one insert past Postgres' 65,535 parameters: at most 200 notes per artifact,
    inserts in batches, the index reads only what it can use); restore note counts were
    approximate; a slow "opened" request could override a status chosen right after opening;
    exports included removed members' reading states.

- **PR 17, P1B-SHARE: share links** (`src/modules/sharing`, migration `0010_share_links`,
  DATA_MODEL §4.1, API_CONTRACT §8, SECURITY.md §5 and §7, ADR-020):
  - Owners and editors create links from the artifact page: an advisory pre-share check
    first (sensitivity, key and token formats, private keys, emails, intranet URLs,
    suspicious preview files; samples masked), then the options (reading, preview, download,
    expiry up to 365 days, a label), then the URL, shown once. Only the token's SHA-256 is
    stored. A private artifact becomes "unlisted"; "private" again revokes every link; a
    restricted artifact cannot be shared. Links list their use (views, last opened) and can
    be revoked. Everything is audited; tokens never are.
  - The public reader `/s/:token` (no session, no workspace data besides the artifact):
    reading mode, the sandboxed preview through a share-scoped token that the preview route
    re-checks on every file (revalidated, never served from cache), the original's download
    (5-minute signed URL), the thumbnail. Every failure is the same 404; every `/s/*`
    request is rate limited per client address (`rate_limit_buckets`, cleaned hourly), with
    `no-referrer` and `noindex`.
  - `ReadingBody` takes a `thumbnailSrc` and `PreviewFrame` a `mintUrl`, so members and
    link holders share them; `ViewSwitch` moved to `src/components/reader`.
  - Tests: `tests/unit/sharing/scan.test.ts` (each pattern, masking, intranet vs public URLs,
    suspicious files, adversarial 2 MB inputs under 600 ms), the preview token's share scope,
    `tests/integration/sharing/sharing.test.ts` (token stored only as a hash, near-miss
    tokens, options, restricted, revoked / expired / private / restricted / deleted,
    cross-workspace, capability limits, the scan, views, the share-scoped preview stopping
    with its link, TTL bound to the link, download flag and audit, thumbnail, preview refresh,
    rate limit, counters under concurrency and their cleanup),
    `tests/integration/api/shares-api.test.ts` (URL shape, no tokens in lists, the
    acknowledgement, strict bodies, CSRF, visibility, viewers 403, strangers 404), and E2E
    (create → open in a fresh context → revoke → 404 → private again). Mutation-checked: each
    `live()` condition, the preview route's link check, the download flag, the TTL cap, the
    preview flag, the rate-limit bound, private revoking links, the restricted refusal, and
    both token-scope rules.
  - Found while testing, fixed here: the email pattern cost ~64 steps per character on long
    letter runs (1.2 s per 2 MB; now anchored, ~20 ms), and `localhost.example.com` was
    reported as an intranet URL.
  - Codex review found, and this PR fixes with tests that fail without the fix: the scan read
    only extracted text, which keeps link labels and drops raw HTML blocks, so
    `[報告](https://wiki.internal/…)`, a `mailto:` or `<div>…@…</div>` in Markdown went
    unreported although the reader shows them. The scan now reads the normalized Markdown as
    the reader shows it (escapes undone) plus the extracted text, and counts distinct values,
    so a label and its destination count once.
  - An independent review found, and this PR fixes, each with a test that fails without the
    fix: the JWT pattern (and other token patterns) restarted inside long runs (`-eyJ`×500k
    blocked the server 8 s; all now anchored); IPv6 clients could rotate inside their /64
    past the rate limit (now keyed by /64); the 365-day option failed when the browser's
    clock ran ahead (`expiresInDays`, counted by the server); shared preview files were not
    rate limited; a missing thumbnail object gave a 500; "private" skipped revoking when the
    artifact already was private; preview-only links showed nothing for images. Tests now
    also cover an older version's preview token after a new version, and previews after
    "private". The docs no longer claim downloads stop at once (a handed-out URL lasts 5
    minutes).

- **PR 18, P1B-OPS: usage and status** (`src/modules/ops`, API_CONTRACT §9.1, FR-OPS-2/3):
  - `/settings/usage` (owners; linked from settings) and `GET /api/ops/usage`
    (`workspace:admin`): originals (count, bytes, missing, corrupt), preview files,
    thumbnails, stored export archives, their total; artifacts and versions (deleted
    artifacts excluded; their originals still count as stored); the database's size; jobs by
    status and the 10 latest failures; failed imports and the 10 latest; the last successful
    export and integrity check and the latest attempts of each. Every number is a query over
    the workspace's rows (sizes as recorded when stored, the provider is not asked); AI usage
    says Phase 2.
  - Tests: `tests/integration/ops/usage.test.ts` (an empty workspace, sums against the
    tables, isolation from another workspace, deleted artifacts, missing/corrupt, failed
    jobs newest first and cut, export and integrity state, a newer failed export, retention,
    owners only) and E2E (the page with real numbers after the import spec). Mutation-checked:
    the workspace scopes of storage and jobs, export retention, deleted artifacts, the
    last-successful-export filter, ordering, the error cut, and the owner permission.
  - Codex review found, and this PR fixes with a test that fails without it: failures were
    dated by `updatedAt`, which staging cleanup refreshes days later, so old import failures
    showed as new and pushed recent ones off the list; they are dated by `completed_at`.
  - An independent review found, and this PR fixes: the share E2E's "signed-out" visitor
    context inherited the admin session (now `SIGNED_OUT`, and it is checked to land on
    /login); job counts are limited by job-row retention, now said on the page
    (`JOB_RETENTION_DAYS`, one constant shared with maintenance); `INTERNAL_ERROR` texts
    (raw paths and driver messages) are no longer shown; the library count used a
    `count(distinct)` over a join that sorted on disk at ~100k versions (two counts now);
    exports and integrity checks lacked an isolation test (added, mutation-checked); the ops
    E2E depended on the import spec (now creates its own failed file, work and export); the
    report now reads one snapshot, and "last completed" ignores rows without a completion time.
  - Known limits: `derived_assets` has no index leading with `workspace_id`, so its sums scan
    the table (about 130 ms at a million rows; fine for an owner page). "N 天前" counts 24-hour
    periods. Totals include the recorded size of missing or corrupt originals. The failed
    import count is a history: a later successful re-upload does not clear it.
  - E2E now signs in **once** (`tests/e2e/auth.setup.ts`, the `setup` project) and every
    spec reuses that session (`E2E_ADMIN_STATE`); tests of anonymous access use
    `test.use({ storageState: SIGNED_OUT })`. Sign-in is limited to 5 a minute per address
    and the run already used all 5, so one more spec signing in failed. Do not add sign-ins
    to specs; `login(page)` only signs in again if the session is gone.

- **PR 19, P1B-DETAIL: source metadata editing** (`updateVersionSource` in
  `src/modules/artifacts/edit.ts`, API_CONTRACT §5):
  - `PATCH /api/artifacts/:id/versions/:versionId` (`library:write`, strict body):
    platform (≤ 100), model and author (≤ 200; the title text rules: visible, NFC, one line),
    research date (a real `YYYY-MM-DD`, year ≥ 1), source URL (http(s), no credentials,
    ≤ 2,048, normalized); `null` or empty clears. The artifact is locked first, the version
    must belong to it, the artifact is re-indexed in the same transaction (the current
    version's source fields are search metadata) and `artifact_version.updated` is audited
    with the field names. Only import and restore wrote these fields before; nothing
    rewrites an edit later, and exports carry them as before.
  - The detail page's "來源資訊" card shows the source URL (a link only when it is http(s),
    with `noopener noreferrer nofollow`) and, for editors, a form (platform picker with the
    known platforms plus an imported unknown value, model, date, author, URL).
  - Tests: `tests/integration/api/version-source-api.test.ts` (cleaning, clearing, search
    finds the new model, the audit fields, every validation rule, older versions, another
    artifact's version, stranger 404, viewer 403, deleted artifact) and E2E
    (`tests/e2e/source.spec.ts`: edit, display, link attributes, search and the model
    filter). Mutation-checked: the re-index, the version-belongs-to-artifact condition, the
    URL scheme and credential rules, the real-day check, the write permission.
  - Codex review found, and this PR fixes with an E2E that fails without it: an untouched
    imported URL the browser refuses (`http://%zz/report`; the Markdown importer keeps any
    `http(s)://` value) blocked saving any other field; the form is `noValidate`, only
    changed fields are sent, and the server validates them.
  - An independent review found, and this PR fixes: the edit locked the artifact before the
    version, the reverse of the search index job, and deadlocked with a job for the same
    version (reproduced; a deterministic test in
    `tests/integration/library/version-source-locks.test.ts` fails with the old order);
    imported URLs with credentials (`https://trusted@evil/`) rendered as links (one predicate,
    `src/lib/url.ts`, for edits and display; the link shows the parsed address); a stale
    error reappeared after cancel; a test now checks search ignores an older version's edit.
  - Not built: `originalPrompt` and `changeSummary` editing (in the contract as planned).

- **PR 20, P1B-E2E: phone viewport** (`tests/e2e/library.mobile.spec.ts`, the `mobile`
  project; the desktop project now ignores `*.mobile.spec.ts`, which it used to run too):
  - On a Pixel 7: import (a long hyphenated filename, a long CJK title, an unbroken Latin
    title, a long URL in the text), the navigation drawer, the library, search, an artifact
    (preview and reading), the share panel, the public share reader (with the download card's
    filename and SHA-256), collections, projects, settings and usage. Every page must not
    scroll sideways: `scrollWidth <= screen.width`. Not `innerWidth`: a mobile browser zooms
    out to fit wide content, so the layout viewport grows with it and that check always passes.
  - It found, and this PR fixes: the artifact page laid out at 918 px on a phone (its grid's
    implicit `auto` column grew to the widest unbreakable text, and the sidebar lacked
    `min-w-0`; now `grid-cols-1` and `min-w-0`), and search snippets with long URLs (now
    `break-words`). The usage page's grid and library card titles got the same treatment.
    Removing the grid fix fails the spec.
  - An independent review found that the first version still passed falsely: a card click
    navigates on the client and returns at once, so the check measured the library again. Each
    measurement now waits for something only the measured page has; the spec also creates a
    long collection and project name, opens the library filters, measures both views of an
    artifact and waits for search indexing. That found, and this
    PR fixes: the artifact and share-reader `<h1>`, outline links, the project link, manager
    and picker names (now `break-words`), and selects and filter labels that grew to their
    longest option or name (`max-w-full min-w-0`). A failing check names the culprits (the
    deepest elements whose content is wider than their box). Removing the `<h1>` fix fails
    the spec and names the `<h1>`.
  - Codex found that a CI retry (`retries: 1`, same database) could never pass: the
    first attempt's work, collection and share were still there (a second work with the same
    title, a 409 on the collection name, a second share row). `attempt()` in
    `tests/e2e/helpers.ts` names the attempt; the phone and share specs put it in every
    filename, title, name and search term they create. Checked by failing the first attempt
    on purpose with `--retries=1`: the retry failed before and passes now. `source.spec`
    already passed its retry (its filename makes the retry a new version of the same work).
    Older specs (`import.spec`, …) were not checked for this.

**Not done or not verified**

- No Simplified↔Traditional folding in search (SEARCH_DESIGN §9).
- Collections: no manual ordering yet (`sort_order` and item `position` are stored; the UI
  sorts by name and lists items like the library). The import page has no project or
  collection picker; both work through `POST /api/imports`.
- Search has no `statement_timeout`. A one-character query over a very large library holds
  a connection for its whole run (0.4 s at 120,000 matching chunks today).
- Development databases that applied an earlier draft of `0006_search_index` (before PR 12
  merged) must be reset: the migration was regenerated with a new timestamp.
- Tag operations re-index every affected artifact synchronously. Fine for a personal
  library; a tag on many thousands of artifacts would make a rename slow.

- Reading mode shows document images as alt text only. Serving derived images of imported
  documents through an authorized route is not built.

- Preview limits:
  - Root-relative URLs (`/style.css`) inside imported sites resolve to the preview host root
    and 404; relative URLs work.
  - Directory links (`docs/`) are redirected by Next.js to `docs` (trailing-slash 308) and
    404; there is no directory-index resolution.
  - No `Range` support. It is not needed while preview files are limited to
    HTML/CSS/JS/JSON/images/fonts/text/PDF.
  - Owner tokens cannot be revoked early. They expire after 15 minutes; deleting the
    artifact stops the server at once, but a browser may show its cached copy for up to
    5 minutes. (Share-scoped previews are revalidated on every load.)
- Sharing limits:
  - The rate limits key on the client address from `X-Forwarded-For`, trusted as for sign-in.
    Exposed without a proxy that overwrites the header, clients choose their own address;
    requests with no usable address share one "unknown" budget (DEPLOYMENT §5.6).
  - A link follows the current version: adding a version to a shared artifact shares it
    without a new check. A handed-out download URL outlives a revocation by up to 5 minutes.
  - Restriction and deletion suspend links (no undo exists yet; one must revoke them).
  - The pre-share check is pattern-based and advisory; it scans at most 2,000,000
    characters of extracted text, plus metadata and preview file names.
  - A restored artifact keeps its archived visibility, but links are never exported, so an
    "unlisted" artifact restores without links (readable by no one outside the workspace).
  - The rate-limited reader page answers 200 with a message (a Server Component cannot set
    a 429); the `/s/*` routes answer 429.
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

**Phase 1A is feature-complete.** Remaining Phase 1A items:

- P1A-ENC: built-in `age` encryption for exports.
- Verify the S3 adapter against real R2. This needs the owner's credentials.

**Then Phase 1B** (ROADMAP; one PR each):

1. **P1B-VERSION-SPLIT (PR 21): split a wrongly matched version into its own artifact.**
   Imports match versions by filename stem (`match_reason`), which can be wrong.
   `POST /api/artifacts/:id/versions/:versionId/split` (`library:write`, A) moves the version
   (and only it) to a new artifact in the same workspace, in one transaction:
   - lock order: the version, then its artifact (the search index job's order), then insert
     the new artifact (title from the version's extraction title or its filename; private;
     the same project); refuse when it is the artifact's only version (409, nothing to split);
   - the version gets `artifact_id` = the new one and `version_number` 1; the old artifact
     keeps its other versions' numbers (gaps are fine) and, if the split version was current,
     its newest remaining version becomes current;
   - `content_chunks`, `derived_assets`, `extracted_documents` follow the version
     (`artifact_id` columns where they exist) — check every table with an `artifact_id` or a
     composite `(workspace_id, artifact_id)` FK; `file_assets` never change (immutable);
   - notes, tags, collections, reading state and share links stay with the old artifact;
   - re-index both artifacts' metadata documents; audit `artifact_version.split` with both
     ids; the import item's `result_artifact_id` is left as the historical record.
     UI: a "拆成獨立作品" action per version in the detail page's version list (two-step
     confirm), then go to the new artifact. Tests: the move, numbering, current version,
     chunks and search on both sides, the only-version refusal, isolation, viewer 403, a lock
     test against `indexVersion` like PR 19's, and export/restore of the result.
2. **P1B-LIBRARY remainder:** library statistics (counts by kind, storage used) on the
   library page, read from the same queries as the usage page.
3. **Phase 1A leftovers:** P1A-ENC (`age` encryption for exports) and verifying the S3 adapter
   against real R2 (needs the owner's credentials).
