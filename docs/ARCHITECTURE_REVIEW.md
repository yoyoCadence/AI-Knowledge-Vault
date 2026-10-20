# Architecture Review of the Master Specification

> Status: accepted (2026-10-20). This is the Step 1 review of the master specification
> (`docs/PRODUCT_SPEC.md`). Each finding names the risk, the resolution, and where the
> resolution lives. No core requirement was removed. Where a requirement was re-scoped, the
> reason is stated.

## Summary verdict

The specification is sound in its priorities: preservation before intelligence, privacy by
default, and verified restore. Its main weaknesses are:

1. Several decisions it leaves open are load-bearing, and leaving them open would cause
   rework: preview origin isolation, worker hosting, CJK search and version matching.
2. Its table list is closer to the final system than to Phase 1, so building it up front
   would create many empty tables.
3. Real Claude Design exports are less self-contained than the spec assumes (see F-03).

## Findings

### F-01 Preview isolation needs a second origin, and the deployment must provide it

- **Risk:** The spec asks for untrusted HTML on a separate origin but recommends a single Next.js
  app. If preview HTML is served from the main origin, any script that slips through
  (sandbox misconfiguration, a browser bug, a future "allow scripts" toggle) runs with the
  user's session cookie in scope.
- **Resolution:** One deployment answers on two hostnames: `APP_ORIGIN` (UI and API, with
  cookies) and `PREVIEW_ORIGIN` (untrusted content only, never receives cookies). `proxy.ts`
  routes by `Host`, so preview paths are refused on the app host and app paths on the preview
  host. Preview requests are authorized by a short-lived HMAC token in the URL path, not by
  cookies. In production `PREVIEW_ORIGIN` should be a different registrable domain, not only
  a different subdomain. Local dev uses `localhost` vs `127.0.0.1`. See ADR-007 and
  `SECURITY.md` §5.

### F-02 Background work cannot live in serverless request handlers

- **Risk:** Import, extraction, export and restore are long-running. Serverless HTTP
  functions are killed after their timeout.
- **Resolution:** A Postgres-backed job table plus a separate long-running Node worker
  process, built from the same codebase. The recommended topology is a container platform
  that runs a `web` process and a `worker` process (Fly.io, Railway, Render, or a VPS).
  Vercel is acceptable for `web` only if the worker runs elsewhere. See ADR-005 and
  `DEPLOYMENT.md`.

### F-03 Claude Design exports are not self-contained

- **Observation** (from a real export provided by the owner, analysed locally and not committed):
  - The ZIP holds `<name>.dc.html`, `support.js`, `_ds/<design-system>/{styles.css, _ds_bundle.js, …}`
    and `.thumbnail` (a WebP image).
  - `support.js` loads React, ReactDOM and Babel from `unpkg.com` at runtime.
  - The document uses custom elements (`<x-dc>`, `<helmet>`, `<sc-if>`), `{{ placeholder }}`
    bindings, and a `<script type="text/x-dc">` component.
  - Fonts load from Google Fonts.
- **Implications:**
  1. The static content (headings, paragraphs, tables, sources) is fully present in the HTML,
     so extraction works without running any JavaScript.
  2. Full interactive fidelity requires running third-party code fetched from a CDN. If
     unpkg.com changes or disappears, even the original ZIP will no longer render
     interactively. "Preserve the ZIP" alone is therefore not enough for long-term fidelity.
  3. Safe, script-free preview shows the static layout; `{{ }}` placeholders show inside
     interactive widgets.
- **Resolution:**
  - Phase 1 classifies these files as `claude_design_document` (a sub-kind of static HTML),
    extracts content with the template syntax stripped, uses `.thumbnail` as the cover, and
    shows a "script-free preview" notice.
  - The CDN dependency is recorded in the version's preview analysis (`externalDependencies`).
  - Future work (Phase 3) is a vendored, pinned dc-runtime served only from the isolated
    preview origin with a strict allow-list. See ROADMAP P3-PREVIEW-RUNTIME.

### F-04 Same-hash deduplication can leak information across tenants

- **Risk:** If dedup were global, a future second user could learn whether someone else
  stored a file, by uploading it and observing "duplicate".
- **Resolution:** Dedup is scoped to the workspace: `UNIQUE(workspace_id, sha256)`. Storage
  keys are also workspace-prefixed.

### F-05 "Same artifact, different version" has no deterministic rule in the spec

- **Resolution:** This is defined in `IMPORT_PIPELINE.md` §6:
  1. An explicit `targetArtifactId` always wins.
  2. Otherwise, a match on the _distinctive_ normalized filename stem (generic stems such as
     `index`, `report` or `untitled` are excluded) inside the same workspace creates a new
     version, and the item records `matchReason = filename_stem`.
  3. Content similarity never merges. It is only flagged as `suspected_duplicate`.

### F-06 Traditional Chinese full-text search will not work with stock PostgreSQL parsers

- **Risk:** The `simple` and `english` parsers treat a run of CJK characters as one token, so
  searching `熱島` would not match `城市熱島`. `zhparser` and `pg_jieba` are not available on
  Neon. `pg_trgm` cannot use its index for 1–2 character patterns, and most Chinese words
  are two characters.
- **Resolution:** Tokenize in the application. CJK runs become overlapping bigrams plus
  unigrams; Latin text is NFKC-normalized, lower-cased words. The result is stored as a
  `tsvector`. Queries become phrase queries over bigrams with prefix matching for Latin
  terms. Because a `tsvector` stops recording positions after 16,383, indexing is per chunk,
  not per document. This was verified with Traditional Chinese test fixtures. See ADR-009
  and `SEARCH_DESIGN.md`.

### F-07 The table list is too large for Phase 1

- **Resolution:** `DATA_MODEL.md` documents the full target model. Migrations create tables
  only when the phase that uses them lands. Some spec tables were merged or renamed with a
  reason (for example, `extraction_errors` became `extracted_documents.warnings`/`error_*`,
  and `export_jobs` and `backup_runs` became `export_runs`/`restore_runs`). See
  `DATA_MODEL.md` §2.

### F-08 Backup encryption must not create a key-loss single point of failure

- **Risk:** An encrypted backup whose key is lost is worse than no backup. A key stored next
  to the archive gives no protection.
- **Resolution:** The export format is defined as plaintext ZIP plus an optional outer
  encryption layer using the open `age` format, which can be decrypted with the standalone
  `age` CLI without this application. Phase 1A ships the unencrypted portable archive with
  an explicit UI and docs warning, plus the documented `age` procedure. Built-in `age`
  encryption is ROADMAP P1A-ENC. See `BACKUP_RECOVERY.md` §4.

### F-09 Share links: retrievability versus secrecy

- **Decision:** Only `SHA-256(token)` is stored. The full link is shown once at creation;
  to share again, create another link. This trades a little convenience for "a database
  leak does not leak working links". See ADR-011.

### F-10 Rate limiting and sessions must work across instances

- **Resolution:** Better Auth rate limiting uses `storage: "database"`, not in-memory, and
  sessions live in Postgres. No Redis is needed in Phase 1.

### F-11 Telemetry and third-party calls

- **Resolution:** Better Auth telemetry is explicitly disabled. The app makes no outbound
  calls except to the configured storage, the database and, from Phase 2 on, AI providers
  that the user has opted into.

### F-12 Cost risks

- **Neon free tier:** 0.5 GB storage and limited compute hours; autosuspend adds cold-start
  latency. This is adequate for about 1,000 artifacts of extracted text. Watch for TOAST
  growth.
- **R2:** 10 GB free with zero egress. Original files dominate storage; derived preview
  files roughly double ZIP storage, which is acceptable.
- **Worker host:** about 5 USD/month on common container platforms. No free tier is assumed
  to be permanent.
- **AI (Phase 2+):** per-run budget caps, content-hash caching, and no automatic re-analysis
  on page view.

### F-13 Missing fields added to the model

These were added:

- `artifacts.identity_key` (version matching)
- `artifacts.origin_ref` (restore provenance)
- `artifacts.deleted_at` (soft delete)
- `artifact_versions.active_extraction_id`
- `file_assets.storage_status`, `integrity_verified_at`
- `import_items.client_key` (idempotent declaration)
- `processing_jobs.locked_until`/`run_after`/`idempotency_key`
- `share_links.allow_download` (separate from read)
- `artifact_versions.preview_kind`/`preview_status`

### F-14 Spec items deferred with justification

- Thumbnails rendered from HTML screenshots need a headless browser in the worker, which is
  heavy. Phase 1 uses an embedded thumbnail (Claude Design `.thumbnail`), the first image in
  the archive, or a typographic placeholder.
- DOCX/PPTX/EPUB and URL import are explicitly Future in the spec.
- Encrypted export: see F-08.

## Non-negotiables preserved

The following are all reflected in code and tests, not only in documentation:

- original immutability (DB trigger and storage conditional writes)
- private by default
- the AI-optional core
- verified restore
- object-level authorization
