# Active Plan

_Last updated: 2026-10-27 by the implementing agent._

## Current focus

**PR 20 (this branch): P1B-E2E, phone viewport.** A Pixel 7 spec over every main page
(navigation drawer, library, search, reading mode, share panel, the public share reader,
settings and usage) asserting no horizontal overflow; it found the artifact page laid out at
918 px on a phone, fixed here.

**Next: P1B-VERSION-SPLIT (PR 21).** The exact steps are in `docs/HANDOFF.md` §4.

**Merge rule:** CI must be green **and** the PR's code review must have been read and its
findings handled. If the review bot is unavailable, run an independent review first.

## PR sequence (each merged to `main` before the next starts)

1. ✅ Phase 0 foundation: docs, toolchain, DB, storage, jobs, shell, CI.
2. ✅ P1A-AUTH (PR 2):
   - Better Auth with Drizzle adapter and mapped tables
   - `admin:create` CLI, which creates the user, workspace and owner membership
   - `getActor`/`requireActor`
   - login page and logout
   - dashboard protection (redirect to `/login`)
   - API 401
   - DB rate limit on sign-in
   - audit events
   - integration tests: sign-in success/failure, disabled sign-up, rate limit, session revoke
3. ✅ P1A import slice 1 (PR 3):
   - schema (projects, artifacts, versions, file_assets with immutability trigger,
     artifact_files, derived_assets, import_batches/items, extracted_documents,
     document_sections)
   - import API (batch, item, upload URL, complete) plus the local storage upload route
   - worker `import.process_item` for HTML/MD/TXT/PDF/image
   - download original
   - tests
4. ✅ P1A import slice 2 (PR 4):
   - safe ZIP reader, classification (Claude Design / static site / framework / unsupported)
   - derived preview files and thumbnails
   - version matching and suspected duplicates
   - retry and cancel, staging cleanup
   - 50-item batch test
   - security tests (traversal, bomb, symlink)
5. ✅ P1A import UI: dropzone, progress and report, plus the library grid and detail page (PR 5).
   - ✅ Hardening (PR 6): the review findings on PRs 1–4.
6. ✅ P1A export and restore (PR 7 export + restore core; PR 8 integrity; PR 9 restore UI).
   - format v1, export job, restore job, CLI
   - integrity check
   - round-trip and tamper tests
7. P1B (several PRs):
   - library and detail pages
   - ✅ preview origin (PR 10)
   - ✅ reading mode (PR 11)
   - 🚧 search (PR 12: keyword search; filters with organization)
   - ✅ organization: tags (PR 13), projects and filters (PR 14), collections (PR 15)
   - ✅ notes and reading state (PR 16)
   - sharing
   - ops dashboard
   - E2E

## Open questions for the owner

These do not block the work; defaults were chosen and documented:

- **Production domains** (app plus a separate preview domain).
  Default: none yet (DEPLOYMENT.md §6).
- **Hosting choice.**
  Default recommendation: container platform, Option A.
