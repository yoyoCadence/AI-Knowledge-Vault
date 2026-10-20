# Handoff

The current state of the project, written for an agent or engineer who has no access to earlier
conversations. Update it at the end of every PR.

## 1. Snapshot (2026-10-20, after PR 2: P1A-AUTH)

**Merged and tested**

- **PR 1, Phase 0:** docs, toolchain, Drizzle and migrations, storage adapters (local and
  S3/R2), the Postgres job queue and worker, the app shell, CI, and the Dockerfile. The Docker
  image is built in CI only.
- **PR 2, authentication:**
  - `src/modules/auth/auth.ts`: Better Auth with the following settings.
    - Email and password only; sign-up and every unused endpoint are disabled via
      `disabledPaths`, which makes them return 404.
    - Sessions are stored in the database.
    - Rate limiting is database-backed: 5 sign-ins per minute per IP, 30 requests per minute
      for other endpoints.
    - Telemetry is off, and IDs are UUIDv7.
    - An after-hook writes audit rows for login success, login failure (email hash only) and
      logout.
  - `src/modules/auth/actor.ts`: `resolveActor` maps a session to
    `{userId, workspaceId, role, sessionId, email, name}`. In Phase 1 each user has one
    workspace (the earliest membership).
  - `src/modules/auth/policy.ts`: the role → action table.
  - `src/modules/auth/admin.ts` and `scripts/admin-create.ts`: create the user, credential
    account (scrypt via `better-auth/crypto`), workspace and owner membership, then write an
    audit row.
  - `src/modules/auth/sessions.ts`: list, revoke and revoke-others for sessions, never
    returning tokens.
  - App wiring:
    - `src/app/api/auth/[...all]/route.ts` (lazy, so the build needs no secrets)
    - `src/app/_lib/session.ts` (`getCurrentActor`, `requirePageActor`)
    - `src/app/api/_lib/route.ts` (`authedRoute`: CSRF check → actor → permission →
      structured errors)
    - the login page, the user menu with logout, and the Settings page listing sessions
  - `src/proxy.ts`: an optimistic redirect to `/login` when there is no session cookie (a UX
    convenience only; every page and API still checks server-side) plus preview-host
    isolation.
  - E2E: `playwright.config.ts` and `tests/e2e/*` run against `next start` on port 3100 with
    their own database (`vault_e2e`), seeded with one admin. CI job `e2e`.

**Not done or not verified**

- The S3 adapter has not been verified against real Cloudflare R2.
- There is no passkey, MFA or password reset. Password reset is intentionally disabled; the
  admin resets passwords with the CLI. That CLI subcommand is not written yet: P1A-AUTH-RESET.
- Client IP for rate limiting comes from `x-forwarded-for`. Behind a proxy that does not
  overwrite that header, clients could spoof it. Configure the platform to set it, and set
  `TRUSTED_PROXIES` when deploying (DEPLOYMENT.md §5.6).

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

## 4. Next steps (exact): PR 3, import slice 1 (P1A-FILES + P1A-IMPORT-API + worker for single files)

1. **Schema** (new migration `0001_library_import`), per DATA_MODEL §4.2–4.3:
   - Tables: `research_projects`, `artifacts`, `artifact_versions`, `file_assets`,
     `artifact_files`, `derived_assets`, `import_batches`, `import_items`,
     `extracted_documents`, `document_sections`.
   - Circular FKs: `artifacts.current_version_id` and
     `artifact_versions.active_extraction_id`.
   - A custom migration for the `file_assets` immutability trigger.
2. **`modules/files`:**
   - `storeOriginal(stagingKey)`: stream + SHA-256 + sniff, then a conditional put to
     `storageKeys.original`.
   - `getOriginalDownload(actor, versionId)`: a signed URL plus an audit row.
3. **`modules/imports`:**
   - `createBatch`, `declareItem` (idempotent on `clientKey`; signed upload URL),
     `completeItem` (head check + `enqueueJob` in the same transaction), `getBatchReport`,
     `retryItem`, `cancelItem`.
   - A state machine in `state.ts`.
4. **`src/app/api/storage/local/{upload,download}/route.ts`:** token-verified streaming, local
   adapter only.
5. **`modules/extraction`:**
   - format sniffing
   - HTML, Markdown and text extractors (sections, title, language)
   - PDF via `unpdf`
   - image metadata via `sharp`
6. **Worker handler `import.process_item`**, registered in `src/worker/registry.ts`. It must be
   idempotent: check `import_items.status` first, rely on content-addressed storage, and do
   one DB transaction for the artifact, version, files, extraction and item status.
7. **Tests:**
   - integration: upload → process → persist → download, with byte-equal SHA-256
   - same-hash duplicates
   - running the job twice
   - cross-workspace download returns 404
   - the immutability trigger
