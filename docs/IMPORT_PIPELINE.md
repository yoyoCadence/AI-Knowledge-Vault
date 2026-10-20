# Import Pipeline

Implements FR-IMP-_, FR-FILE-_, FR-PRV-1 and FR-PRV-4. Code: `src/modules/imports`,
`src/modules/extraction`, `src/modules/files`, `src/modules/artifacts`.

## 1. Stages

| #   | Stage                                    | Where             | Notes                                                                                                                  |
| --- | ---------------------------------------- | ----------------- | ---------------------------------------------------------------------------------------------------------------------- |
| 1   | Authenticate upload request              | API               | `requireActor()` + `can(actor, 'import:create')`                                                                       |
| 2   | Create import batch                      | API               | `POST /api/imports`                                                                                                    |
| 3   | Validate declared filename and size      | API               | Zod; extension allow-list; `declared_size ≤ IMPORT_MAX_FILE_BYTES`; filename sanitized (no control chars, ≤ 255 bytes) |
| 4   | Create time-limited upload authorization | API               | `createSignedUploadUrl(stagingKey, {contentLength, expiresIn: 900})`                                                   |
| 5   | Upload to staging                        | Browser → storage | direct PUT, so bytes never pass through app memory (local adapter: streamed to disk)                                   |
| 6   | Mark upload complete                     | API               | `headObject` must exist with `size == declared_size`; enqueue job in the same transaction                              |
| 7   | Server-side content validation           | Worker            | magic-byte sniffing; actual size ≤ limit                                                                               |
| 8   | SHA-256                                  | Worker            | streaming hash while reading staging                                                                                   |
| 9   | Hash duplicate check                     | Worker            | `file_assets(workspace_id, sha256)`                                                                                    |
| 10  | Store immutable original                 | Worker            | `ws/{ws}/originals/{sha256}`, conditional write                                                                        |
| 11  | Identify content type                    | Worker            | §3                                                                                                                     |
| 12  | Safe parse                               | Worker            | §4 (ZIP limits), parsers with timeouts                                                                                 |
| 13  | Extract title, sections, body, metadata  | Worker            | `modules/extraction`                                                                                                   |
| 14  | Normalized content                       | Worker            | `normalized_markdown`, `plain_text`, `content_hash`                                                                    |
| 15  | Full-text index                          | Worker            | Phase 1B: `search.index_version` job enqueued after commit                                                             |
| 16  | Preview or fallback                      | Worker            | derived preview files and thumbnail                                                                                    |
| 17  | Update artifact and version              | Worker            | single DB transaction                                                                                                  |
| 18  | Update job and item status               | Worker            |                                                                                                                        |
| 19  | Import report                            | API/UI            | `GET /api/imports/:id`                                                                                                 |

## 2. Supported formats (Phase 1A)

| Format        | Detection                                                                                   | Content kind                                | Preview kind                                          | Extraction                                                          |
| ------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------- |
| HTML          | `<!doctype html`/`<html` within the first 1 KB after BOM/whitespace; extension `.html/.htm` | `html_document` or `claude_design_document` | `static_html` (A)                                     | html extractor                                                      |
| ZIP           | `PK\x03\x04` magic                                                                          | see §3                                      | A/B/C/D                                               | archive analysis + html extractor on the entry document             |
| PDF           | `%PDF-`                                                                                     | `pdf`                                       | `pdf` (browser built-in viewer on the preview origin) | unpdf text per page                                                 |
| Markdown      | `.md/.markdown` + valid text encoding                                                       | `markdown`                                  | `text_only`                                           | markdown extractor                                                  |
| TXT           | `.txt` + valid text encoding                                                                | `text`                                      | `text_only`                                           | text extractor                                                      |
| PNG/JPEG/WEBP | magic bytes                                                                                 | `image`                                     | `image`                                               | none (title from filename); sharp validates and creates a thumbnail |

Anything else is rejected at declaration (extension) or by the worker (magic mismatch) with
`UNSUPPORTED_FILE_TYPE`. Claimed types are never trusted: an `.html` that is really a ZIP is
treated as a ZIP. An `.html` that is really an executable is rejected.

## 3. ZIP classification

> **Status:** designed. Implementation is P1A-ZIP, the next PR. Until then, ZIP uploads are
> preserved byte-for-byte as `content_kind = archive_other` with extraction error
> `ARCHIVE_ANALYSIS_UNAVAILABLE`. They become analysable through a reprocess job once the ZIP
> pipeline lands.

The worker builds an **inventory** (entry list with sizes) using the safe reader (§4), then
classifies it:

1. **Claude Design export (`claude_design_document`, type A/B):** has a `*.dc.html` at the root
   (or one directory level down), and may have `support.js`, `_ds/` and `.thumbnail`. Entry
   document: the `.dc.html`. Thumbnail: `.thumbnail` if it sniffs as an image.
2. **Framework source project (`framework_project`, type C):** `package.json` exists AND
   (`vite.config.*`, `next.config.*`, `src/main.tsx|jsx|ts|js`, `src/App.*`, a `index.html`
   that references `/src/main`, or a `"dev"`/`"build"` script) AND there is no prebuilt output
   directory with an index (`dist/index.html`, `build/index.html`, `out/index.html`). If a
   prebuilt output exists, it is type B with the entry inside it. Scripts are **never** run.
3. **Static website (`static_site`, type B):** has an `index.html` (shallowest wins) or exactly
   one `.html` file. Entry: that file.
4. **Document bundle:** no HTML, but Markdown/PDF/TXT entries. The largest readable document is
   the entry; content kind follows it, and the preview kind is `text_only`/`pdf`.
5. **Unsupported (`archive_other`, type D):** none of the above, or an inventory violation.
   The original is preserved and the reason recorded.

For types A and B, files are copied to `derived/{versionId}/site/{path}` and listed in
`derived_assets(kind = preview_file)`, but only files with allowed extensions: html, htm, css,
js (stored, never executed in preview), json, svg, png, jpg, jpeg, gif, webp, avif, ico, woff,
woff2, ttf, otf, txt, md and pdf. Other files stay inside the original only.

Also recorded in `artifact_versions.analysis`:

- `entryCount`, `totalUncompressed`, `topLevelDirs`
- `externalDependencies`: hosts referenced by `<script src>`/`<link href>`/`@import`/`url()`,
  for example `unpkg.com` and `fonts.googleapis.com`
- `hasScripts`
- `nestedArchives`: names only; nested archives are never extracted
- `warnings`

## 4. ZIP safety limits

These are configurable through env; defaults are in `src/infrastructure/config/env.ts`.

| Threat                    | Control                                                                                                                                                                                                         | Default                                      |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| Path traversal / Zip Slip | Reject entries whose normalized path is absolute, has a drive letter, contains `..`, NUL, or backslashes that normalize to traversal. Paths are only ever used as **keys**, never joined onto a filesystem path | —                                            |
| Symlinks                  | Reject entries whose Unix mode is a symlink (`(externalAttributes >> 16) & 0o170000 == 0o120000`)                                                                                                               | —                                            |
| Zip bomb (total)          | Count **actual** decompressed bytes while streaming and abort when the total exceeds the limit (headers are not trusted)                                                                                        | `ZIP_MAX_TOTAL_UNCOMPRESSED_BYTES` = 512 MiB |
| Zip bomb (single entry)   | Per-entry actual byte cap                                                                                                                                                                                       | `ZIP_MAX_ENTRY_BYTES` = 128 MiB              |
| Compression ratio         | Abort if `uncompressed/compressed` exceeds the limit for any entry > 1 MiB                                                                                                                                      | `ZIP_MAX_COMPRESSION_RATIO` = 200            |
| Entry count               | Inventory abort                                                                                                                                                                                                 | `ZIP_MAX_ENTRIES` = 5,000                    |
| Path depth / length       | Reject entries deeper than limit or longer than 512 bytes                                                                                                                                                       | `ZIP_MAX_PATH_DEPTH` = 24                    |
| Nested archives           | Never extracted; listed only                                                                                                                                                                                    | —                                            |
| Encrypted entries         | Rejected (`general purpose bit 0`)                                                                                                                                                                              | —                                            |
| Duplicate names           | The later duplicate (after normalization, case-insensitive) is ignored, with a warning                                                                                                                          | —                                            |
| Processing time           | Whole-item timeout; the job fails with `PROCESSING_TIMEOUT`                                                                                                                                                     | `IMPORT_ITEM_TIMEOUT_MS` = 300,000           |
| Malicious HTML/JS         | Never executed server-side. Preview is script-free (SECURITY.md §5). Extraction parses without executing                                                                                                        | —                                            |

Violations make the item `failed`, with `error_code = ARCHIVE_REJECTED` and a precise reason
(for example `ZIP_ENTRY_PATH_TRAVERSAL: ../../etc/passwd`). The original is still preserved:
the immutable original is stored _before_ deep analysis, and an `unsupported` artifact version
is created. This means a rejected ZIP can be downloaded and inspected later. **Exception:** if
the outer file itself exceeds the size limit or fails magic sniffing, it is not preserved.

## 5. Duplicate handling (FR-IMP-7/8/9)

1. **Same file hash** in the same workspace → item `duplicate`, `outcome = duplicate_file`,
   `match_reason = same_hash`. No version is created; the item links to the existing
   artifact and version that reference that `file_asset`.
2. **Same artifact, different version** (deterministic, §6) → new `artifact_versions` row,
   `version_number = max + 1`, and `artifacts.current_version_id` is updated.
3. **Possibly duplicate content:** the new version's `content_hash` (normalized plain text)
   equals another artifact's version hash, or the normalized title is identical → the item
   records `suspected_duplicate_of` and a warning. **No merge happens.**

## 6. Version matching rule

Applied in order. The first match wins.

1. `import_items.target_artifact_id` is set (the user chose "upload as new version of …")
   → new version of that artifact (must be in the same workspace, otherwise 404).
2. `batch.options.autoVersionByFilename` (default `true`) and the item's **identity key**
   matches exactly one non-deleted artifact in the workspace → new version of it
   (`match_reason = filename_stem`).
   - Identity key = filename without extension(s) (`.dc.html`, `.html`, `.zip`, `.tar.gz` …),
     then NFKC, lower-case, with copy suffixes stripped (`(1)`, ` copy`, `-final`, `_v2`,
     ` v3`, `-2026-10-20`), and `_`/`-`/whitespace collapsed to a single space.
   - Keys shorter than 6 characters, or in the generic list (`index`, `report`, `document`,
     `untitled`, `download`, `export`, `main`, `readme`, `output`, `project`, `design`,
     `new`, `file`, `page`, `site`, `website`, `home`), never match. They still get an
     identity key stored for display, prefixed with `generic:`.
   - If two or more artifacts match → no auto-version; a new artifact is created with a
     warning `AMBIGUOUS_VERSION_MATCH`.
3. Otherwise → a new artifact.

The import report shows, for every new version, "added as V{n} of {title} (reason)". This
lets the user spot a wrong match. Splitting a version into its own artifact is
ROADMAP P1B-VERSION-SPLIT.

## 7. Metadata extraction (never guess)

- **Title:** `<title>` → first `<h1>` → first heading → filename stem.
- **Language:** `<html lang>`. If absent, the script ratio: Han characters ≥ 30% of letters →
  `zh-Hant` if Traditional-only characters are present, otherwise `zh`; else `en` when ASCII
  letters dominate; else `und`.
- **source_platform:** set to `claude_design` **only** when the Claude Design structure is
  detected (§3.1). Otherwise `null`. The user can set it at batch level
  (`options.sourcePlatform`).
- **source_model:** only from an explicit declaration: `<meta name="ai-model|llm-model|model">`
  or front-matter `model:`/`ai_model:`. `<meta name="generator">` names the authoring software;
  it is stored as `analysis.generator`, never as the model. The detector never infers a model
  from style.
- **research_date:** only from explicit metadata (front-matter `date:`, or
  `<meta name="date">`/`article:published_time`). Never the file mtime.
- **reference_sources:** links inside a section whose heading matches
  `/^(sources?|references?|bibliography|來源|參考(資料|文獻)?|引用)$/i`, capped at 200.

## 8. Recovery and idempotency

The import handler derives the version, artifact and derived-asset IDs deterministically from
the import item ID (UUIDv5; see ADR-008 amendment). A retry after a crash therefore overwrites the
same derived objects instead of leaving orphans, and the commit transaction re-checks the item
status under a row lock, so two runs can never both commit.

| Scenario                                                      | Mechanism                                                                                                                                                                                             |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Client retries item declaration                               | `unique(batch_id, client_key)` returns the existing item and a fresh upload URL                                                                                                                       |
| Client calls complete twice                                   | Complete is a no-op once the item is `queued` or beyond; the job is created with `idempotency_key = import_item:{id}`, and `ON CONFLICT DO NOTHING`                                                   |
| Worker crash after storing the original, before the DB commit | Re-run: the `If-None-Match` put sees an existing object → `headObject` verifies size and hash metadata → continues                                                                                    |
| Worker crash after the DB commit, before the item update      | Item and artifact are updated in the same transaction, so this cannot happen                                                                                                                          |
| Retry of a failed item                                        | `POST /api/imports/:batch/items/:item/retry` → status `queued`, job reset (`attempt_count = 0`, `run_after = now`). Allowed only if the staging object still exists or the original is already stored |
| Staging object orphaned (item expired or cancelled)           | `maintenance.cleanup_staging` (hourly): deletes staging objects of items in a terminal state older than 24 h, and items in `awaiting_upload` past `upload_expires_at` → `expired`                     |
| DB says stored, object missing                                | Integrity check (`integrity.check`) marks it `missing`; surfaced in the UI and restore docs                                                                                                           |

## 9. Concurrency

- `WORKER_CONCURRENCY` (default 2) bounds parallel jobs per worker process.
- A 50-item batch is processed in ≈ 25 rounds, and each job holds at most one archive stream.
- The upload UI limits parallel PUTs to 3.
