# Active Plan

_Last updated: 2026-10-20 by the implementing agent._

## Current focus

**PR 1 (this branch): Phase 0 Foundation.** It is complete and will be merged.

**Next: PR 2 — P1A-AUTH.**

## PR sequence (each merged to `main` before the next starts)

1. ✅ Phase 0 foundation: docs, toolchain, DB, storage, jobs, shell, CI.
2. P1A-AUTH:
   - Better Auth with Drizzle adapter and mapped tables
   - `admin:create` CLI, which creates the user, workspace and owner membership
   - `getActor`/`requireActor`
   - login page and logout
   - dashboard protection (redirect to `/login`)
   - API 401
   - DB rate limit on sign-in
   - audit events
   - integration tests: sign-in success/failure, disabled sign-up, rate limit, session revoke
3. P1A import slice 1:
   - schema (projects, artifacts, versions, file_assets with immutability trigger,
     artifact_files, derived_assets, import_batches/items, extracted_documents,
     document_sections)
   - import API (batch, item, upload URL, complete) plus the local storage upload route
   - worker `import.process_item` for HTML/MD/TXT/PDF/image
   - download original
   - tests
4. P1A import slice 2:
   - safe ZIP reader, classification (Claude Design / static site / framework / unsupported)
   - derived preview files and thumbnails
   - version matching and suspected duplicates
   - retry and cancel, staging cleanup
   - 50-item batch test
   - security tests (traversal, bomb, symlink)
5. P1A import UI: dropzone, progress and report.
6. P1A export and restore:
   - format v1, export job, restore job, CLI
   - integrity check
   - round-trip and tamper tests
7. P1B (several PRs):
   - library and detail pages
   - preview origin and reading mode
   - organization
   - search
   - sharing
   - ops dashboard
   - E2E

## Open questions for the owner

These do not block the work; defaults were chosen and documented:

- **Production domains** (app plus a separate preview domain).
  Default: none yet (DEPLOYMENT.md §6).
- **Hosting choice.**
  Default recommendation: container platform, Option A.
