# Security

## 1. Assets

| Asset                                    | Sensitivity                                    | Notes                                                        |
| ---------------------------------------- | ---------------------------------------------- | ------------------------------------------------------------ |
| Original research files                  | High (private research, possibly confidential) | Immutable, private by default                                |
| Extracted text, notes                    | High                                           | Same protection as originals                                 |
| Account credentials, sessions            | Critical                                       | scrypt hashes and session tokens in Postgres; never exported |
| Storage and DB credentials, auth secrets | Critical                                       | Server-side env only                                         |
| Share-link tokens                        | Medium                                         | Grant read of one artifact; only hashes stored               |
| Audit logs                               | Medium                                         | Integrity matters for forensics                              |

## 2. Threat model (STRIDE summary)

| Threat                 | Example                                                                         | Mitigations                                                                                                                                                       |
| ---------------------- | ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Spoofing               | Credential stuffing on login                                                    | Rate limiting (database-backed), no public sign-up, generic error messages, scrypt hashing, session rotation on login                                             |
| Tampering              | Overwrite an original via a crafted upload or retry                             | Content-addressed keys, conditional writes, DB trigger on `file_assets`, server-side hash verification                                                            |
| Repudiation            | "I never shared that"                                                           | `audit_logs` for share/visibility/export/restore/download events                                                                                                  |
| Information disclosure | IDOR on `/api/artifacts/:id`; private items in search; preview stealing cookies | Workspace-scoped queries in every service; 404 (not 403) for objects outside the scope; search filters by workspace; preview on a separate origin without cookies |
| Denial of service      | Zip bomb, huge PDF, 10k-entry ZIP                                               | Streaming limits (IMPORT_PIPELINE §4), job timeouts, bounded concurrency, upload size limits                                                                      |
| Elevation of privilege | Script in imported HTML acting on the main origin; prompt injection (Phase 2)   | Script-free preview on an isolated origin; reading mode never renders raw HTML; retrieved text is treated as data in AI prompts                                   |

## 3. Trust boundaries

```
[Internet] ──TLS──▶ [web: APP_ORIGIN]  ← authenticated user (cookie session)
[Internet] ──TLS──▶ [web: PREVIEW_ORIGIN] ← anyone holding a valid preview token; NEVER cookies
[Browser]  ──signed PUT──▶ [Object storage] ← one key, one size, 15-minute TTL
[web/worker] ──▶ [Postgres], [Object storage] ← server secrets
[worker] ──▶ untrusted file bytes (parsing only; never executed)
[Phase 2] [worker/web] ──▶ [AI provider] ← only content allowed by the sensitivity policy
```

Untrusted inputs include:

- every uploaded byte
- filenames, ZIP entry names, and HTML/PDF metadata
- preview tokens (verified with HMAC and constant-time compare) and share tokens (format
  checked, then looked up by their SHA-256; a lookup's timing can reveal something about a
  hash, never about a token)
- query strings
- `Host`/`Origin` headers (compared against configured origins)

## 4. Upload security

1. Declaration is validated with Zod:
   - The extension must be on the allow-list.
   - `declared_size ≤ IMPORT_MAX_FILE_BYTES` (default 200 MiB).
   - The filename is sanitized: NFC; control characters, `/`, `\` and NUL removed; at most
     255 UTF-8 bytes. The original name is kept for display only.
2. The signed upload URL binds the method (PUT), the exact key, `Content-Length` (S3
   presign signs it) and a 15-minute expiry. The local adapter verifies an HMAC token with
   the same binding plus a streamed byte limit.
3. The worker re-verifies the actual size, the magic bytes and the hash. It never trusts the
   client MIME type.
4. Staging and originals are separate key prefixes. Staging is deleted after processing.
5. Zip-specific controls are in IMPORT_PIPELINE §4.
6. Images are decoded by sharp with `limitInputPixels` (default 100 MP) to stop
   decompression-bomb images.
7. PDF parsing runs with a page cap (`PDF_MAX_PAGES`, default 2,000) and the item timeout.
   JavaScript inside PDFs is never executed, because pdf.js text extraction does not run
   scripts.

## 5. Preview isolation (FR-PRV-2, ADR-007)

Layers:

1. **Separate origin.** `PREVIEW_ORIGIN` differs from `APP_ORIGIN` in host. In production
   it should also differ in registrable domain (eTLD+1), so "same-site" cookie semantics
   do not apply.
2. **Host routing.** `proxy.ts` refuses everything except `/p/*` on the preview host
   (returns 404), and refuses `/p/*` on the app host.
3. **No ambient credentials.** Auth cookies are host-only (no `Domain` attribute), so they
   are never sent to the preview host. Preview access uses a path token:
   `base64url(payload).base64url(HMAC-SHA256(PREVIEW_TOKEN_SECRET, payload))`. The payload
   is `{purpose: "preview", v: versionId, w: workspaceId, s: scope, exp: expiry}`
   (`src/modules/preview`). TTL is 15 minutes for owners;
   for share links it is the shorter of the link expiry and 1 hour, re-issued per page view.
   Scopes: `owner` (no link), and `share` with `l: linkId`. For `share` the route checks on
   **every file request** that the link is still live, allows previews, and that the version
   is its artifact's current one, so revoking a link (or making the artifact private,
   restricted or deleted) stops its previews at once, before the token expires. The route
   also re-checks the Host, so a routing mistake cannot serve preview content on the app
   origin.
4. **Response headers:**
   ```
   Content-Security-Policy: default-src 'none'; script-src 'none'; object-src 'none';
     style-src <preview-origin> 'unsafe-inline'; img-src <preview-origin> data: blob:;
     font-src <preview-origin> data:; media-src <preview-origin>; connect-src 'none';
     frame-src 'none'; worker-src 'none'; form-action 'none'; base-uri 'none';
     frame-ancestors <app-origin>; sandbox allow-same-origin
   X-Content-Type-Options: nosniff
   Referrer-Policy: no-referrer
   Cross-Origin-Resource-Policy: cross-origin
   Cache-Control: private, max-age=300
   ```
   PDFs are served with a CSP that omits `sandbox`, because the browser PDF viewer needs it,
   but they stay on the preview origin.
5. **iframe sandbox.** The embedding page uses `<iframe sandbox="" referrerpolicy="no-referrer">`:
   no scripts, no same-origin, no top navigation, no forms, no popups.
6. **Manifest lookup.** The raw (still percent-encoded) path segments are decoded exactly
   once and refused, not cleaned, when they are empty, `.`/`..`, contain an encoded `/` or
   `\`, a control character, or invalid encoding. The result is looked up in
   `derived_assets(version, 'preview_file', path)`, joined to the version and artifact, so a
   deleted artifact or a version whose preview is not `ready` stops serving at once, even
   for live tokens (a browser may still show its own cached copy for up to `max-age=300`).
   Any refusal is the same bare 404; malformed percent-encoding is refused by `proxy.ts`
   before routing. There is no filesystem path join anywhere.
7. **Content-Type.** It comes from our own extension map; uploaded headers are never used.
   `.js` files are served as `text/plain`, which defeats any script execution even if CSP
   failed. No charset is declared: preview files are the original bytes, possibly Big5, so
   the document's own `<meta charset>` or BOM must win. Only `static_html`/`static_site`
   versions get a preview URL; PDFs, images and text are shown by reading mode.

Reading mode (`src/components/reader/markdown-view.tsx`) renders our normalized Markdown
with an allow-list renderer into React elements:

- No raw HTML passthrough: an `html` node is shown as escaped text.
- Only `http(s)`, `mailto` and in-page `#` links stay links. External ones get
  `target="_blank" rel="noopener noreferrer nofollow"`; `javascript:`, `data:` and relative
  targets become plain text.
- Images in documents are shown as their alt text (`［圖片：…］`), so reading never loads
  anything from elsewhere (no tracking pixels). Image versions show our own thumbnail.
- Plain-text extractions are shown preformatted, never interpreted as Markdown.
- Cost is bounded too: some Markdown makes the parser's work grow quadratically and its
  recursion overflow the stack (20 KB of `- - - …` blocks the server for about a minute).
  Notes, the Markdown people type in, must pass `markdownProblem` (`src/lib/markdown.ts`)
  when written and when restored: a linear scan of line nesting (8 markers), indentation (64
  columns), emphasis runs (32) and emphasis marks or brackets per inline stretch (1,000),
  then a parse whose tree may be at most 64 levels deep. What passes parses in about a
  second at most. The renderer itself shows any tree deeper than 64 levels, or any text it
  fails on, as plain text, so a page never fails because of how a text is formatted.

`dangerouslySetInnerHTML` is banned everywhere (`react/no-danger`). In
`src/components/reader/**` a second rule also bans it and `innerHTML`/`outerHTML`
assignment.

## 6. Authentication

- Better Auth with email and password and no sign-up endpoint (`disableSignUp`). The admin is
  created by `pnpm admin:create`, which reads the password from a prompt or the
  `ADMIN_PASSWORD` env var (never from argv, which can leak through `ps`).
- Password policy: minimum 12 characters, maximum 128.
- Sessions:
  - 7-day expiry, refreshed daily
  - cookie `__Secure-vault.session_token` (production), `HttpOnly`, `Secure`, `SameSite=Lax`, host-only
  - all sessions listed and revocable in Settings
- The only other cookie is a preference: `vault_library_layout` (`grid` or `list`), set by the
  library page's switch in the browser (not `HttpOnly`; it carries no credential and no
  data). The server reads anything but `list` as the grid.
- Rate limits (database storage): sign-in 5 per 60 s per IP; other auth routes 30 per 60 s.
- Login failures are recorded in `audit_logs` (no password, email hashed). Successes are
  recorded with IP and UA.
- Audit IPs use the same resolver as the rate limiter (`resolveClientIp`): with
  `TRUSTED_PROXIES` it walks `X-Forwarded-For` from the right past trusted hops. Without them,
  only a single-hop header is believed. Otherwise the IP is recorded as unknown (null), never as
  a client-chosen value.
- Better Auth endpoints we do not use are 404 (`disabledPaths`). This includes `/get-session`
  and the built-in session list/revoke routes, which serialize session tokens. Sessions are
  managed only through the audited `/api/sessions` facade.
- Future: passkeys and TOTP through Better Auth plugins; OAuth only as an _additional_ method.

## 7. Authorization

- `Actor = { userId, workspaceId, role }` comes from the session and the membership row.
- `can(actor, action)` is a role table: owner = all; editor = everything except
  workspace/backup admin; viewer = read.
- **Object-level rule:** every repository query includes `workspace_id = actor.workspaceId`,
  and soft-deleted rows are excluded. Objects outside the scope return **404** with the same
  body as truly missing objects, so existence is not leaked.
- Public access paths (share links, public artifacts, preview tokens) go through
  `modules/sharing`/`modules/preview` resolvers that return a **narrow capability**, for
  example "may read extracted content of version X". The rest of the app's services are
  never called with an anonymous actor.
- **Share links** (P1B-SHARE, ADR-020):
  - A token is 32 random bytes (base64url, 43 characters). Only its SHA-256 is stored; the
    URL is shown once, at creation, and is never logged, audited or exported.
  - `resolveShare` returns a capability only while the link is not revoked, not expired, and
    its artifact is not deleted, not private and not `restricted`. Every other case
    (malformed, unknown, revoked, expired, …) is the same 404.
  - A capability reads one artifact's current version, and only what the link allows:
    reading mode, the sandboxed preview (share-scoped token, §5), the original's download
    (5-minute signed URL, audited as `share.original.downloaded`). Notes, tags,
    collections, other versions and anything else of the workspace are never read. A link
    follows the artifact's **current** version: a version added later is shared too (the
    panel says so).
  - Revoking a link (or making its artifact private, restricted or deleted) stops its pages,
    files and previews at once. A download URL already handed out stays valid for the rest
    of its 5 minutes.
  - Creating a link makes a private artifact `unlisted` (the owner confirms this); making it
    private again revokes every link for good (also when it already was private: the sweep
    always runs). Restricted artifacts cannot be shared. Restriction and deletion suspend
    links rather than revoke them; nothing can undo either today, and a future undo must
    revoke them.
  - Before creating a link the owner sees an advisory scan (`checkShare`) of what the reader
    shows (the normalized Markdown with escapes undone, so link destinations and raw HTML
    blocks are included, plus the extracted text): sensitivity, well-known key and token
    formats, private keys, email addresses, intranet URLs, and preview files that usually
    hold secrets. Counts are distinct values. It is advisory: it cannot prove a document clean.
  - `/s/*` responses send `Referrer-Policy: no-referrer` and `X-Robots-Tag: noindex,
nofollow`, are never cached, and are rate limited per client address
    (`rate_limit_buckets`, 120 requests a minute, unknown tokens included); share-scoped
    preview files are limited too (600 a minute). Addresses are trusted as for sign-in
    (DEPLOYMENT §5.6), and an IPv6 client counts by its /64.
  - Every pattern of the pre-share scan is anchored where a run starts, so the scan is linear
    in its (capped) input; adversarial inputs are unit-tested.

## 8. CSRF

- Cookies use `SameSite=Lax`.
- Every mutating `/api/*` handler (POST/PUT/PATCH/DELETE) runs `assertSameOrigin(request)`:
  - `Origin` must equal `APP_ORIGIN`
  - or, if `Origin` is absent, `Sec-Fetch-Site` must be `same-origin`
  - otherwise the request fails with `403 CSRF_REJECTED`
- Better Auth applies its own origin and fetch-metadata checks to `/api/auth/*`.
- Mutating APIs accept only `application/json`, except storage upload routes, which are
  token-authorized.

## 9. Storage security

- The R2 bucket is private, with no public bucket URL or r2.dev subdomain.
- CORS on the bucket allows `PUT` and `GET` from `APP_ORIGIN` only (DEPLOYMENT.md).
- Signed download URLs: 5-minute TTL, a single key, and
  `response-content-disposition=attachment`. They are generated only after authorization.
- Storage keys contain IDs and hashes but are **never** a security boundary. Every access is
  authorized first.
- R2 credentials are scoped to a single bucket with Object Read & Write, never account-wide.

## 10. Secrets

- These live only in env or a platform secret store: `BETTER_AUTH_SECRET`,
  `PREVIEW_TOKEN_SECRET`, `LOCAL_STORAGE_SIGNING_SECRET`, `DATABASE_URL` and `S3_*`.
- Each secret must be ≥ 32 characters (validated at startup).
- `.env*` files are git-ignored. `.env.example` contains only placeholders.
- Pino redaction covers secrets, and the env validation error output prints variable names,
  never values.
- Exports exclude `users` password hashes, `sessions`, `auth_accounts`,
  `auth_verifications`, `auth_rate_limits` and share token hashes (FR-BAK-2).
- Export encryption passphrases and age recipients' keys are never stored (ADR-022): the
  passphrase is used while an encrypted download streams and is not written to the
  database, job payloads, the audit log or logs (redacted as `passphrase`). Validation
  errors never echo it. The export panel keeps it out of React state and clears it once
  sent; the request body is capped at 16 KiB and must be exactly a form or JSON. scrypt
  runs on the thread pool, one at a time, at most four waiting (429 past that), so
  encrypted downloads cannot stall the server or exhaust its memory. The vault holds no
  private key; a lost passphrase cannot be recovered.
- The backup CLIs take a passphrase only from an environment variable the operator names
  (`--passphrase-env`), never from argv, which `ps` shows to every user, and delete it from
  their environment once read. Encrypted exports and their sidecars are created 0600 and never
  overwrite a file. A decrypted archive exists only as a 0600 file in a fresh 0700 temporary
  directory for the length of the restore.

## 11. Input validation and injection

- **Zod** validates every request body and query.
- **SQL:** Drizzle parameterizes everything. Raw SQL fragments use the `sql` template with
  bound parameters only. `sql.raw` is banned outside migrations.
- **XSS:** React escapes by default. There is no raw HTML in the app origin, and search
  snippets are built as text segments, not HTML strings.
- **Path traversal:** storage keys are built only by `storageKeys.*` helpers from validated
  UUIDs and hashes. The local adapter resolves the key under its root and asserts
  containment.
- **SSRF:** there is no server-side URL fetching in Phase 1. Future URL Import must use an
  allow-list resolver that blocks private IP ranges after DNS resolution, plus redirect
  limits.

## 12. Privacy rules

- Private artifacts never appear in public endpoints. There is no public search in Phase 1.
- `unlisted` pages send `X-Robots-Tag: noindex, nofollow` and are absent from any sitemap.
  There is no sitemap in Phase 1.
- Thumbnails and preview files are served only through authorized routes or preview tokens.
- Logs never contain document text, filenames with a `sensitivity = restricted` flag, or
  tokens.
- `restricted` content is never sent to external AI providers by default (Phase 2 policy
  gate).

## 13. Security test inventory

See `TEST_PLAN.md` §4: unauthorized read and download, share revocation, path traversal ZIP,
zip bomb, symlink entry, malicious HTML (script-free preview headers), API permission bypass
(cross-workspace IDs), private search leakage, expired signed URL, CSRF rejection, and
`file_assets` immutability trigger.
