import { and, eq, isNull } from "drizzle-orm";
import type { DbExecutor } from "@/infrastructure/database/client";
import { artifacts, artifactVersions, derivedAssets } from "@/infrastructure/database/schema";
import { isUuid } from "@/lib/ids";
import { signToken, verifyToken, type SignedTokenClaims } from "@/lib/signed-token";
import { getVersionWithOriginal } from "@/modules/artifacts";
import type { Actor } from "@/modules/auth";
import { mimeForPath } from "@/modules/extraction";

/**
 * Preview origin access (docs/SECURITY.md §5, ADR-007). Untrusted imported HTML is only ever
 * served from PREVIEW_ORIGIN, under `/p/<token>/<path>`, where the token is an HMAC path token
 * binding one version of one workspace for a short time. No cookies are involved: the preview
 * host never sees the app's session.
 */

export const PREVIEW_TOKEN_PURPOSE = "preview";
export const OWNER_PREVIEW_TTL_SECONDS = 15 * 60;
/**
 * Preview kinds this origin renders as a site. PDFs, images and text get their view in reading
 * mode instead: a `sandbox=""` frame cannot show a PDF, so a ZIP holding one PDF is not a site.
 */
export const SITE_PREVIEW_KINDS = new Set(["static_html", "static_site"]);

export interface PreviewClaims extends SignedTokenClaims {
  v: string; // artifact version id
  w: string; // workspace id
  /** "owner": issued to a member; "share": issued to the holder of share link `l`. */
  s: "owner" | "share";
  l?: string; // share link id, for "share" only
}

export function createPreviewToken(
  secret: string,
  input: { versionId: string; workspaceId: string; shareLinkId?: string },
  now = new Date(),
  ttlSeconds = OWNER_PREVIEW_TTL_SECONDS,
): { token: string; expiresAt: Date } {
  const exp = Math.floor(now.getTime() / 1000) + ttlSeconds;
  const claims: PreviewClaims = {
    purpose: PREVIEW_TOKEN_PURPOSE,
    exp,
    v: input.versionId,
    w: input.workspaceId,
    ...(input.shareLinkId ? { s: "share", l: input.shareLinkId } : { s: "owner" }),
  };
  return { token: signToken(secret, claims), expiresAt: new Date(exp * 1000) };
}

/**
 * Returns the claims of a valid token, or null for anything else (callers answer 404). A
 * "share" token is only valid in form here: its link must still be live, which the preview
 * route checks on every request (`shareAllowsPreview`).
 */
export function verifyPreviewToken(secret: string, token: string, now = new Date()) {
  const result = verifyToken<PreviewClaims>(secret, token, PREVIEW_TOKEN_PURPOSE, now);
  if (!result.ok) return null;
  const { v, w, s, l } = result.claims;
  if (typeof v !== "string" || !isUuid(v) || typeof w !== "string" || !isUuid(w)) return null;
  if (s === "owner") return l === undefined ? result.claims : null;
  if (s === "share") return typeof l === "string" && isUuid(l) ? result.claims : null;
  return null;
}

/**
 * Normalizes the requested site path from its raw (still URL-encoded) segments. Anything that
 * could escape or alias a path is refused rather than "cleaned": empty, `.`/`..`, encoded
 * slashes or backslashes, NUL and other control characters, or invalid percent-encoding.
 * There is no filesystem: the result is only ever used as a lookup key.
 */
export function normalizePreviewPath(rawSegments: string[]): string | null {
  if (rawSegments.length === 0 || rawSegments.length > 32) return null;
  const segments: string[] = [];
  for (const raw of rawSegments) {
    let segment: string;
    try {
      segment = decodeURIComponent(raw);
    } catch {
      return null;
    }
    if (
      segment === "" ||
      segment === "." ||
      segment === ".." ||
      /[/\\]/.test(segment) ||
      // Control characters (incl. NUL) never appear in stored preview paths.
      /[\u0000-\u001f\u007f]/.test(segment)
    ) {
      return null;
    }
    segments.push(segment.normalize("NFC"));
  }
  const path = segments.join("/");
  return path.length <= 1024 ? path : null;
}

/**
 * The preview file at `path` of the token's version, or null (→ 404). A version whose artifact
 * was deleted, or whose preview is no longer ready, stops serving at once, even for live tokens.
 */
export async function findPreviewFile(
  db: DbExecutor,
  target: { versionId: string; workspaceId: string },
  path: string,
) {
  const [asset] = await db
    .select({
      storageKey: derivedAssets.storageKey,
      byteSize: derivedAssets.byteSize,
      sha256: derivedAssets.sha256,
    })
    .from(derivedAssets)
    .innerJoin(artifactVersions, eq(artifactVersions.id, derivedAssets.artifactVersionId))
    .innerJoin(artifacts, eq(artifacts.id, artifactVersions.artifactId))
    .where(
      and(
        eq(derivedAssets.artifactVersionId, target.versionId),
        eq(derivedAssets.workspaceId, target.workspaceId),
        eq(derivedAssets.kind, "preview_file"),
        eq(derivedAssets.path, path),
        eq(artifactVersions.previewStatus, "ready"),
        isNull(artifacts.deletedAt),
      ),
    );
  return asset ?? null;
}

/**
 * Content type from our own map; scripts are served as plain text (SECURITY.md §5.7). No
 * charset is declared: preview files are the original bytes, which may be Big5 or another legacy
 * encoding (ADR-010), so the browser must honour the document's own `<meta charset>` or BOM.
 * Charset sniffing cannot run anything here: scripts are off by CSP and sandbox.
 */
export function previewContentType(path: string): string {
  const mime = mimeForPath(path);
  return mime === "text/javascript" ? "text/plain" : mime;
}

export function previewHeaders(input: {
  appOrigin: string;
  previewOrigin: string;
  contentType: string;
}): Record<string, string> {
  const self = input.previewOrigin;
  const directives = [
    "default-src 'none'",
    "script-src 'none'",
    "object-src 'none'",
    `style-src ${self} 'unsafe-inline'`,
    `img-src ${self} data: blob:`,
    `font-src ${self} data:`,
    `media-src ${self}`,
    "connect-src 'none'",
    "frame-src 'none'",
    "worker-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
    `frame-ancestors ${input.appOrigin}`,
  ];
  // The browser's PDF viewer does not work inside a CSP sandbox; PDFs still stay on this origin.
  if (!input.contentType.startsWith("application/pdf"))
    directives.push("sandbox allow-same-origin");
  return {
    "content-type": input.contentType,
    "content-security-policy": directives.join("; "),
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "cross-origin-resource-policy": "cross-origin",
    "cache-control": "private, max-age=300",
  };
}

/** Signed preview URL for a version the actor can read, or null when it has no preview. */
export async function issuePreviewUrl(
  db: DbExecutor,
  actor: Actor,
  input: { artifactId: string; versionId: string },
  env: { PREVIEW_ORIGIN: string; PREVIEW_TOKEN_SECRET: string },
  now = new Date(),
): Promise<{ url: string; expiresAt: Date; expiresInSeconds: number } | null> {
  const { version } = await getVersionWithOriginal(db, actor, input.artifactId, input.versionId);
  if (
    version.previewStatus !== "ready" ||
    !version.previewEntryPath ||
    !SITE_PREVIEW_KINDS.has(version.previewKind)
  ) {
    return null;
  }
  const entry = await findPreviewFile(
    db,
    { versionId: version.id, workspaceId: actor.workspaceId },
    version.previewEntryPath,
  );
  if (!entry) return null;
  const { token, expiresAt } = createPreviewToken(
    env.PREVIEW_TOKEN_SECRET,
    { versionId: version.id, workspaceId: actor.workspaceId },
    now,
  );
  const encodedPath = version.previewEntryPath.split("/").map(encodeURIComponent).join("/");
  return {
    url: `${env.PREVIEW_ORIGIN}/p/${token}/${encodedPath}`,
    expiresAt,
    // Clients schedule refreshes from this, not from expiresAt: their clocks may be wrong.
    expiresInSeconds: OWNER_PREVIEW_TTL_SECONDS,
  };
}
