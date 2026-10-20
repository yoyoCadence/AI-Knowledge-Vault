# Test Plan

## 1. Layers and tools

| Layer       | Tool       | Location                         | Database                                                                                 | Runs in CI                  |
| ----------- | ---------- | -------------------------------- | ---------------------------------------------------------------------------------------- | --------------------------- |
| Unit        | Vitest     | `tests/unit/**/*.test.ts`        | none                                                                                     | yes                         |
| Integration | Vitest     | `tests/integration/**/*.test.ts` | real PostgreSQL (`DATABASE_URL_TEST`), fresh schema per run; local storage in a temp dir | yes (`postgres:16` service) |
| E2E         | Playwright | `tests/e2e/**/*.spec.ts`         | real Postgres + running `web` + `worker`                                                 | yes (separate job)          |
| Fixtures    | —          | `tests/fixtures/`                | —                                                                                        | —                           |

Rules:

- **No database mocks.** Integration tests exercise SQL, constraints and triggers.
- Fixtures are **synthetic and public**. Private research (including anything the owner
  supplies for manual testing) is never committed. Fixture generators live in
  `tests/fixtures/builders.ts`, and malicious archives are built in code at test time.
- Each test file owns its data (unique workspace per test) so tests stay independent.
- `pnpm test` runs unit and integration tests. `pnpm test:e2e` runs E2E.

## 2. Unit tests (required)

| Area                            | Cases                                                                                                      |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Content hash                    | streaming SHA-256 equals one-shot; empty input; large input in chunks                                      |
| Format sniffing                 | magic bytes for ZIP/PDF/PNG/JPEG/WEBP; HTML detection with BOM/whitespace; extension mismatch handling     |
| Import classification           | Claude Design layout; index.html site; Vite source project; prebuilt `dist/`; document bundle; unsupported |
| ZIP path safety                 | `../`, absolute, drive letter, backslash traversal, NUL, depth, symlink mode                               |
| Identity key / version matching | suffix stripping (`(1)`, `copy`, `_v2`, dates); generic stems; NFKC; Chinese filenames                     |
| Normalization                   | HTML → markdown: headings, lists, tables, links; scripts/styles removed; `{{ }}` stripped; whitespace      |
| Language detection              | zh-Hant vs zh vs en vs und                                                                                 |
| Text decoding                   | UTF-8 BOM, UTF-16 LE BOM, Big5 fallback, invalid bytes                                                     |
| Permission policy               | role × action matrix                                                                                       |
| Preview token                   | sign/verify, expiry, tamper, wrong secret                                                                  |
| Search tokenizer (1B)           | bigrams + unigrams + positions; Latin prefixes; NFKC full-width; query escaping                            |
| Export manifest                 | checksums format (`sha256sum`-compatible); manifest schema                                                 |
| Env validation                  | missing/short secrets fail; local storage in production refused                                            |

## 3. Integration tests (required)

| Area                      | Cases                                                                                                                                                         |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Migrations                | apply to an empty DB; `file_assets` immutability trigger blocks updates to immutable columns                                                                  |
| Jobs                      | enqueue idempotency; concurrent claims never double-claim (SKIP LOCKED); retry/backoff; lease expiry recovery; max attempts → failed; heartbeat extends lease |
| Storage adapter           | local: put/get/head/delete/list; conditional put refuses overwrite; signed upload token binds key and size; expired token rejected; containment               |
| Upload → import → persist | HTML, ZIP site, Claude-Design-like ZIP, PDF, MD, TXT, image → artifact + version + file asset + extraction + derived files                                    |
| Batch                     | 50 small items succeed; one corrupt ZIP and one traversal ZIP fail without affecting others                                                                   |
| Idempotency               | completing twice; re-running a job; retrying a failed item → no duplicate artifacts, versions or file assets                                                  |
| Duplicates                | same hash → `duplicate`; renamed same name → new version; same text, different bytes → `suspected_duplicate_of`                                               |
| Download original         | bytes and SHA-256 equal the upload; cross-workspace access → 404                                                                                              |
| Export → Restore          | round trip into a fresh schema and storage; skip_existing idempotency; copy mode; tamper → abort                                                              |
| Search (1B)               | Traditional Chinese 2-char and 4-char, adjacency, English prefix, full-width, isolation, snippets                                                             |
| Share authorization (1B)  | valid, revoked, expired, private artifact, download flag                                                                                                      |

## 4. Security tests (required)

| Test                   | Expectation                                                                                                          |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Unauthorized read      | API without a session → 401; another workspace's artifact → 404                                                      |
| Unauthorized download  | original download without access → 404; signed URL bound to one key                                                  |
| Expired signed URL     | local token past expiry → 403/404                                                                                    |
| Share revocation       | revoked or expired link → 404                                                                                        |
| Path traversal ZIP     | item failed `ARCHIVE_REJECTED`; nothing written outside the derived prefix                                           |
| Zip bomb               | high-ratio entry aborted at the limit; memory bounded                                                                |
| Symlink entry          | rejected                                                                                                             |
| Malicious HTML         | preview response has `script-src 'none'`, `sandbox`, `nosniff`; reading mode output has no `<script>`/event handlers |
| API permission bypass  | IDs from another workspace in every route family → 404                                                               |
| Private search leakage | search never returns other workspaces' or deleted artifacts                                                          |
| CSRF                   | mutating request with a foreign `Origin` → 403                                                                       |
| Immutability           | direct SQL `UPDATE file_assets SET sha256 = …` raises an error                                                       |
| Host routing           | `/p/*` on the app host → 404; app routes on the preview host → 404                                                   |

## 5. E2E scenarios (Phase 1B exit)

Implemented so far (`tests/e2e/`):

- `auth.spec.ts`: anonymous redirect, wrong password, login → sessions → logout, open-redirect refusal.
- `import.spec.ts`: an HTML file with a Traditional Chinese name, a Claude Design ZIP and a broken
  file are uploaded through the UI. The report shows 2 succeeded and 1 failed with a precise
  error code. The library shows both works. The detail page shows the outline, and the original
  download is byte-identical (SHA-256). Anonymous API access returns 401.

Note: Chromium in some containers drops file _paths_ with non-ASCII names in `setInputFiles`, so the
specs pass in-memory payloads (`{ name, mimeType, buffer }`). Real browsers are unaffected, and the
integration tests also cover CJK filenames.

1. Admin login (and failed login message).
2. Batch upload (drag and drop via file chooser) of 5 fixtures.
3. View import progress until complete; one deliberately broken file shows a reason.
4. Open an artifact: preview iframe present, reading mode shows headings.
5. Search Chinese text, then open the result.
6. Change category or collection.
7. Add a note.
8. Create a share link, then open it in a fresh context without cookies.
9. Revoke it; the link returns 404.
10. Export, restore into a second workspace, and see the restored artifact.

## 6. Exit-criteria traceability (Phase 1A)

| Exit criterion              | Test                                                                                                                           |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| 1 HTML upload               | `tests/integration/imports/pipeline.test.ts › imports an HTML file end-to-end`                                                 |
| 2 ZIP upload                | `tests/integration/imports/archives.test.ts › Claude Design export`, `› framework source`; `tests/unit/extraction/zip.test.ts` |
| 3 PDF upload                | `tests/integration/imports/pipeline.test.ts › imports PDF, Markdown, Big5 text and PNG`                                        |
| 4 50-item batch             | `tests/integration/imports/archives.test.ts › batch of 50`                                                                     |
| 5 Original download         | `pipeline.test.ts › HTML end-to-end` (byte-identical) and `tests/integration/api/imports-api.test.ts` (HTTP 302 → download)    |
| 6 Hash verification         | `x-content-sha256` check in `imports-api.test.ts`; the integrity job arrives with P1A-INTEGRITY                                |
| 7 Partial failure isolation | `pipeline.test.ts › a bad file fails…`, `archives.test.ts › batch of 50`                                                       |
| 8 Retry without duplicates  | `pipeline.test.ts › completing twice…`, `› a crash after storing the original…`, `archives.test.ts › reconciles…`              |
| 9 Export re-importable      | `backup-roundtrip.test.ts`                                                                                                     |
| 10 No unauthorized access   | `pipeline.test.ts › authorization`, `api/imports-api.test.ts`, `api/sessions-api.test.ts`                                      |

## 7. Commands

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm build
pnpm test:unit            # fast, no DB
pnpm test:integration     # needs DATABASE_URL_TEST
pnpm test:e2e             # builds and starts web + worker against DATABASE_URL_TEST
```
