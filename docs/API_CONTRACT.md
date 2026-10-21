# API Contract

REST-oriented JSON API served by Next.js route handlers under `/api`. Status column:
✅ implemented and tested · 🚧 in progress · 📝 planned.

## 1. Conventions

- **Auth:** session cookie (Better Auth). Every endpoint except `/api/health`, `/api/auth/*`,
  the storage token routes, share resolution and preview requires an authenticated actor.
  Unauthenticated → `401 UNAUTHENTICATED`.
- **CSRF:** mutating methods require a same-origin `Origin` (or `Sec-Fetch-Site: same-origin`).
  Failure → `403 CSRF_REJECTED`.
- **Content type:** request bodies are `application/json`. Others → `415 UNSUPPORTED_MEDIA_TYPE`.
- **Validation:** Zod. Failure → `400 VALIDATION_FAILED` with `details.issues[]` (path and
  message only, never echoing values).
- **Not found / no access:** both → `404 NOT_FOUND`, with an identical body.
- **Errors:** `{ "error": { "code": "STRING_CODE", "message": "human safe", "errorId": "err_…", "details": {…}? } }`.
  `errorId` is present for 5xx and correlates with server logs.
- **Pagination:** `?limit=` (1–100, default 24) and `?cursor=` (opaque). The response is
  `{ items, nextCursor | null }`.
- **IDs:** UUID strings. **Timestamps:** ISO 8601 UTC.
- **Audit:** mutating endpoints record `audit_logs` entries where marked (A).

## 2. System

| Method | Path          | Description                                                             | Status |
| ------ | ------------- | ----------------------------------------------------------------------- | ------ |
| GET    | `/api/health` | `{status: ok/degraded, db, storage, version}`; no auth; leaks no config | ✅     |

## 3. Auth (Better Auth, mounted at `/api/auth/[...all]`)

| Method | Path                                                 | Description                                                                                                                                                                       | Status |
| ------ | ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| POST   | `/api/auth/sign-in/email`                            | `{email, password, rememberMe?}` → HttpOnly `vault.session_token` cookie. 401 on bad credentials, 429 after 5/min/IP. (A: success and failure; failures store only an email hash) | ✅     |
| POST   | `/api/auth/sign-out`                                 | revoke the current session (A)                                                                                                                                                    | ✅     |
| GET    | `/api/auth/get-session`                              | current session (used internally; pages resolve the actor server-side)                                                                                                            | ✅     |
| —      | `/api/auth/sign-up/email` and other unused endpoints | **disabled** via `disabledPaths` (404). Admins are created only by `pnpm admin:create`                                                                                            | ✅     |

### Sessions (our API; never exposes session tokens)

| Method | Path                          | Description                                                                   | Status |
| ------ | ----------------------------- | ----------------------------------------------------------------------------- | ------ |
| GET    | `/api/sessions`               | `{items: [{id, createdAt, expiresAt, ipAddress, userAgent, current}]}`        | ✅     |
| DELETE | `/api/sessions/:id`           | revoke one of the actor's sessions → `{revoked: true}`; 404 if not theirs (A) | ✅     |
| POST   | `/api/sessions/revoke-others` | sign out all other devices → `{revoked: n}` (A)                               | ✅     |

## 4. Imports

| Method | Path                                           | Body / Query                                                                       | Response                                                                                                           | Status |
| ------ | ---------------------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ------ |
| POST   | `/api/imports`                                 | `{projectId?, collectionId?, options?: {autoVersionByFilename?, sourcePlatform?}}` | `201 {batch}`                                                                                                      | ✅     |
| GET    | `/api/imports`                                 | `?limit&cursor`                                                                    | `{items: batchSummary[], nextCursor}` (newest first; `limit` 1–100, default 20)                                    | ✅     |
| GET    | `/api/imports/:batchId`                        | —                                                                                  | `{batch, counts: {total, awaiting_upload, queued, processing, succeeded, duplicate, failed, …}, items: item[]}`    | ✅     |
| POST   | `/api/imports/:batchId/items`                  | `{filename, size, mimeType?, clientKey?, targetArtifactId?}`                       | `201 {item, upload: {url, method: "PUT", headers, expiresAt}}` (idempotent on `clientKey`: `200` with a fresh URL) | ✅     |
| POST   | `/api/imports/:batchId/items/:itemId/complete` | —                                                                                  | `202 {item}` (idempotent)                                                                                          | ✅     |
| POST   | `/api/imports/:batchId/items/:itemId/retry`    | —                                                                                  | `202 {item}`; `409 NOT_RETRYABLE` unless `item.retryable` (failed, staged bytes kept, no version committed)        | ✅     |
| POST   | `/api/imports/:batchId/items/:itemId/cancel`   | —                                                                                  | `200 {item}`                                                                                                       | ✅     |

The spec's `POST /api/imports/:id/upload-url` is implemented as item creation (one URL per
declared file), which makes per-file status and retry addressable.

## 5. Artifacts and versions

| Method | Path                                                   | Description                                                                                                                                                                                                                                                 | Status                           |
| ------ | ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| GET    | `/api/artifacts`                                       | `?tag&project&kind&model&from&to&sort=newest\|oldest&limit&cursor` → cards with `tags`; `model` is the current version's source model, `from`/`to` are YYYY-MM-DD import days in Asia/Taipei; a deleted project filters to nothing. Planned: `collectionId` | ✅                               |
| GET    | `/api/artifacts/:id`                                   | detail (current version, versions summary, `tags`, project, source metadata)                                                                                                                                                                                | ✅                               |
| PATCH  | `/api/artifacts/:id`                                   | `{title?, description?, projectId?}` (`projectId: null` clears; another workspace's or a deleted project is 404; unknown fields are 400; title and description re-index search). Planned: `visibility?, sensitivity?, reviewStatus?` (A)                    | ✅ (title, description, project) |
| DELETE | `/api/artifacts/:id`                                   | soft delete (A)                                                                                                                                                                                                                                             | 📝                               |
| POST   | `/api/artifacts/:id/restore`                           | undo soft delete (A)                                                                                                                                                                                                                                        | 📝                               |
| GET    | `/api/artifacts/:id/versions`                          | list                                                                                                                                                                                                                                                        | 📝                               |
| GET    | `/api/artifacts/:id/versions/:versionId`               | version detail incl. source metadata, analysis, extraction status                                                                                                                                                                                           | 📝                               |
| PATCH  | `/api/artifacts/:id/versions/:versionId`               | source metadata (`sourcePlatform`, `sourceModel`, `originalPrompt`, `sourceUrl`, `researchDate`, `author`, `changeSummary`)                                                                                                                                 | 📝                               |
| GET    | `/api/artifacts/:id/versions/:versionId/original`      | 302 → signed download URL (5 min). Audited                                                                                                                                                                                                                  | ✅                               |
| GET    | `/api/artifacts/:id/versions/:versionId/content`       | `{contentKind, extraction: {method, status, title, language, markdown, warnings}, sections}`; 404 without an extraction                                                                                                                                     | ✅                               |
| GET    | `/api/artifacts/:id/thumbnail`                         | current version WebP thumbnail (authorized; generated by our pipeline, never uploaded bytes; ETag)                                                                                                                                                          | ✅                               |
| POST   | `/api/artifacts/:id/versions/:versionId/preview-token` | `{url, expiresAt}` 15-min URL on the preview origin; 404 without a preview                                                                                                                                                                                  | ✅                               |

`POST /api/artifacts` (create without upload) is intentionally absent: artifacts are created
from imports. A metadata-only artifact type can be added later if needed.

## 6. Research projects, collections, tags, notes, reading state (Phase 1B)

| Method           | Path                                                                                                                                                                             | Status |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| GET/POST         | `/api/projects` (GET with `artifactCount`; POST `{title, description?}` → 201)                                                                                                   | ✅     |
| GET/PATCH/DELETE | `/api/projects/:id` (PATCH `{title?, description?, status?}`; DELETE is soft: the project then reads as missing everywhere, and artifacts referencing it read `projectId: null`) | ✅     |
| GET/POST         | `/api/collections` (tree)                                                                                                                                                        | 📝     |
| PATCH/DELETE     | `/api/collections/:id`                                                                                                                                                           | 📝     |
| PUT/DELETE       | `/api/collections/:id/items/:artifactId`                                                                                                                                         | 📝     |
| GET/POST         | `/api/tags`                                                                                                                                                                      | ✅     |
| PATCH/DELETE     | `/api/tags/:id` · POST `/api/tags/:id/merge` `{intoTagId}`                                                                                                                       | ✅     |
| PUT/DELETE       | `/api/artifacts/:id/tags/:tagId`                                                                                                                                                 | ✅     |
| GET/POST         | `/api/artifacts/:id/notes` · PATCH/DELETE `/api/notes/:id`                                                                                                                       | 📝     |
| PUT              | `/api/artifacts/:id/reading-state` `{status?, isFavorite?}`                                                                                                                      | 📝     |

Projects (built): archiving (`status: archived`) only takes a project out of the pickers;
it can still be assigned through the API and through imports. Titles are 1–200 visible
characters (bidirectional embeddings, overrides and isolates are refused; directional
marks LRM, RLM and ALM are stripped), descriptions up to 2,000 characters without
control characters other than tab and line feed (the same rules as artifact titles and
descriptions, `src/lib/text.ts`). Date filters take YYYY-MM-DD from year 1 on; `model` is
matched exactly as recorded (not trimmed) and may not contain control characters.

Tags (built): `GET /api/tags` → `{items: [{id, name, artifactCount}]}` by name (counts leave
out deleted artifacts). `POST /api/tags {name}` returns the workspace's tag with that name,
`201` when created, `200` when a tag with the same normalized name (NFKC, case, spacing)
already existed. `PATCH /api/tags/:id {name}` → `{tag}`, `409 CONFLICT` with
`details.tagId` when another tag has the name (merge instead). `POST /api/tags/:id/merge
{intoTagId}` → `{tag}` (the target). `DELETE /api/tags/:id` → `{deleted: true}`.
`PUT`/`DELETE /api/artifacts/:id/tags/:tagId` are idempotent and return the artifact's
`{tags}`. Names are 1–50 visible characters (`400` otherwise). Reads need `library:read`,
writes `library:write`; another workspace's tag or artifact is `404`.

## 7. Search (Phase 1B)

| Method | Path          | Description                                                                                                                                                                                                                                                                                    | Status |
| ------ | ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| GET    | `/api/search` | `?q&tag&project&kind&model&from&to&sort=relevance\|newest\|title&offset` → `{items: [{id, title, summary, contentKind, score, snippet: {segments, truncatedStart, truncatedEnd}}], nextOffset, total}` (`total` is null for a page past the last result). Planned: `collectionId`, `matchedIn` | ✅     |

## 8. Sharing (Phase 1B)

| Method | Path                             | Description                                                                                                                            | Status |
| ------ | -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| POST   | `/api/artifacts/:id/share-check` | pre-share safety scan → findings (advisory)                                                                                            | 📝     |
| POST   | `/api/artifacts/:id/shares`      | `{label?, allowPreview, allowReading, allowDownload, expiresAt?, acknowledgeFindings: true}` → `201 {share, url}` (URL shown once) (A) | 📝     |
| GET    | `/api/artifacts/:id/shares`      | list (no tokens)                                                                                                                       | 📝     |
| DELETE | `/api/shares/:shareId`           | revoke (A)                                                                                                                             | 📝     |
| GET    | `/s/:token` (page)               | public reader; 404 if revoked, expired, artifact private or deleted                                                                    | 📝     |

## 9. Backup

| Method | Path                                                         | Description                                                      | Status |
| ------ | ------------------------------------------------------------ | ---------------------------------------------------------------- | ------ |
| POST   | `/api/exports`                                               | `{}` → `202 {export}` (A)                                        | ✅     |
| GET    | `/api/exports`                                               | `{items: export[]}` status and manifest summary                  | ✅     |
| GET    | `/api/exports/:id/download`                                  | 302 → 5-min signed URL, `x-content-sha256` (A)                   | ✅     |
| POST   | `/api/restores` · GET `/api/restores`                        | `{filename, size}` → `201 {restore, upload}` (A, owner) · recent | ✅     |
| POST   | `/api/restores/:id/start`                                    | `{mode}` → `202 {restore}` (A, idempotent; 409 before upload)    | ✅     |
| GET    | `/api/restores/:id`                                          | status and report                                                | ✅     |
| POST   | `/api/integrity-checks` · GET `/api/integrity-checks/latest` | `202 {check}` (A, one pending per workspace) · `{check \| null}` | ✅     |

## 10. Storage (local adapter only)

| Method | Path                                 | Description                                                               | Status |
| ------ | ------------------------------------ | ------------------------------------------------------------------------- | ------ |
| PUT    | `/api/storage/local/upload?token=`   | HMAC token bound to key, size and expiry; streams to disk with a byte cap | ✅     |
| GET    | `/api/storage/local/download?token=` | HMAC token bound to key and expiry                                        | ✅     |

Both return 404 when `STORAGE_DRIVER != local`.

## 11. Preview origin

| Method | Path                            | Description                                                                        | Status |
| ------ | ------------------------------- | ---------------------------------------------------------------------------------- | ------ |
| GET    | `PREVIEW_ORIGIN/p/:token/*path` | Serves derived preview files with the CSP from SECURITY.md §5. 404 on the app host | ✅     |

## 12. AI (Phase 2+, not implemented)

`POST /api/ai/ask`, `POST /api/ai/analyze`, `GET /api/knowledge/topics`, `GET /api/knowledge/gaps`.
See AI_RESEARCH.md.

## 13. Error codes

```
UNAUTHENTICATED, FORBIDDEN, CSRF_REJECTED, NOT_FOUND, VALIDATION_FAILED, UNSUPPORTED_MEDIA_TYPE,
CONFLICT, NOT_RETRYABLE, RATE_LIMITED, PAYLOAD_TOO_LARGE, UNSUPPORTED_FILE_TYPE, UPLOAD_INCOMPLETE,
SIZE_MISMATCH, ARCHIVE_REJECTED, PROCESSING_TIMEOUT, EXTRACTION_FAILED, STORAGE_UNAVAILABLE,
CHECKSUM_MISMATCH, UNSUPPORTED_EXPORT_FORMAT, INTERNAL_ERROR
```
