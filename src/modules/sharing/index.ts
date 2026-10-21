import { createHash, randomBytes } from "node:crypto";
import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import type { Database, DbExecutor } from "@/infrastructure/database/client";
import {
  artifacts,
  artifactVersions,
  derivedAssets,
  documentSections,
  extractedDocuments,
  fileAssets,
  rateLimitBuckets,
  shareLinks,
} from "@/infrastructure/database/schema";
import { AppError, notFound } from "@/lib/errors";
import { isUuid } from "@/lib/ids";
import { cleanTitle } from "@/lib/text";
import { getArtifactForActor } from "@/modules/artifacts";
import { recordAudit, type RequestMeta } from "@/modules/audit";
import type { Actor } from "@/modules/auth";
import type { JobDefinition } from "@/modules/jobs";
import { createPreviewToken, findPreviewFile, SITE_PREVIEW_KINDS } from "@/modules/preview";

/**
 * Share links (FR-SHR, docs/SECURITY.md §7, API_CONTRACT §8).
 *
 * A link is a random 256-bit token; only its SHA-256 is stored, so the database (or a backup of
 * it) never holds a usable link, and the token is shown once, when it is created. A link reads
 * one artifact with the permissions it was created with (preview, reading, download), until it
 * expires, is revoked, or the artifact is made private, deleted or marked restricted. Creating
 * a link makes a private artifact "unlisted" (anyone with a link may read it); making it private
 * again revokes all its links, so they can never come back.
 *
 * The public side never calls the rest of the app with an anonymous actor: `resolveShare`
 * returns a narrow capability, and the reads below take only that capability.
 */

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
export const SHARE_EXPIRY_MAX_DAYS = 365;
export const SHARE_LABEL_MAX = 100;
/** Shared previews get short tokens, re-issued per page view (SECURITY.md §5). */
export const SHARE_PREVIEW_MAX_TTL_SECONDS = 60 * 60;

export const SHAREABLE_VISIBILITIES = ["private", "unlisted"] as const;
export type ShareableVisibility = (typeof SHAREABLE_VISIBILITIES)[number];

export function hashShareToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function newShareToken(): string {
  return randomBytes(32).toString("base64url");
}

export interface ShareSummary {
  id: string;
  label: string | null;
  allowPreview: boolean;
  allowReading: boolean;
  allowDownload: boolean;
  expiresAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
  lastAccessedAt: Date | null;
  accessCount: number;
  /** Not revoked and not expired (the artifact's own state is shown separately). */
  active: boolean;
}

const summaryColumns = {
  id: shareLinks.id,
  label: shareLinks.label,
  allowPreview: shareLinks.allowPreview,
  allowReading: shareLinks.allowReading,
  allowDownload: shareLinks.allowDownload,
  expiresAt: shareLinks.expiresAt,
  revokedAt: shareLinks.revokedAt,
  createdAt: shareLinks.createdAt,
  lastAccessedAt: shareLinks.lastAccessedAt,
  accessCount: shareLinks.accessCount,
};

function summarize(row: Omit<ShareSummary, "active">, now: Date): ShareSummary {
  return { ...row, active: !row.revokedAt && (!row.expiresAt || row.expiresAt > now) };
}

/** Locks a live artifact of the actor's workspace, or throws NOT_FOUND. */
async function lockArtifact(tx: DbExecutor, actor: Actor, artifactId: string) {
  const [artifact] = await tx
    .select({
      id: artifacts.id,
      visibility: artifacts.visibility,
      sensitivity: artifacts.sensitivity,
    })
    .from(artifacts)
    .where(
      and(
        eq(artifacts.id, artifactId),
        eq(artifacts.workspaceId, actor.workspaceId),
        isNull(artifacts.deletedAt),
      ),
    )
    .for("update");
  if (!artifact) throw notFound("Artifact");
  return artifact;
}

/** The artifact's links, newest first, without tokens (they are not stored). */
export async function listShares(
  db: DbExecutor,
  actor: Actor,
  artifactId: string,
  now = new Date(),
): Promise<ShareSummary[]> {
  await getArtifactForActor(db, actor, artifactId);
  const rows = await db
    .select(summaryColumns)
    .from(shareLinks)
    .where(
      and(eq(shareLinks.artifactId, artifactId), eq(shareLinks.workspaceId, actor.workspaceId)),
    )
    .orderBy(desc(shareLinks.createdAt), desc(shareLinks.id));
  return rows.map((row) => summarize(row, now));
}

export interface CreateShareInput {
  label?: string | null;
  allowPreview: boolean;
  allowReading: boolean;
  allowDownload: boolean;
  expiresAt?: Date | null;
}

/**
 * Creates a link and returns its token, the only time it exists outside the requester. A
 * private artifact becomes unlisted in the same transaction (the caller confirmed this); a
 * restricted one cannot be shared.
 */
export async function createShare(
  db: Database,
  actor: Actor,
  artifactId: string,
  input: CreateShareInput,
  meta: RequestMeta,
  now = new Date(),
): Promise<{ share: ShareSummary; token: string; madeUnlisted: boolean }> {
  if (!input.allowPreview && !input.allowReading && !input.allowDownload) {
    throw new AppError("VALIDATION_FAILED", "A link must allow preview, reading or download");
  }
  const label = input.label?.trim()
    ? cleanTitle(input.label, SHARE_LABEL_MAX, "Share labels")
    : null;
  const expiresAt = input.expiresAt ?? null;
  if (expiresAt) {
    const latest = now.getTime() + SHARE_EXPIRY_MAX_DAYS * 24 * 60 * 60 * 1000;
    if (expiresAt.getTime() <= now.getTime() || expiresAt.getTime() > latest) {
      throw new AppError(
        "VALIDATION_FAILED",
        `A link expires in the future, at most ${SHARE_EXPIRY_MAX_DAYS} days ahead`,
      );
    }
  }
  const token = newShareToken();
  return db.transaction(async (tx) => {
    const artifact = await lockArtifact(tx, actor, artifactId);
    if (artifact.sensitivity === "restricted") {
      throw new AppError("CONFLICT", "Restricted artifacts cannot be shared", {
        details: { reason: "RESTRICTED" },
      });
    }
    const madeUnlisted = artifact.visibility === "private";
    if (madeUnlisted) {
      await tx
        .update(artifacts)
        .set({ visibility: "unlisted", updatedAt: now })
        .where(eq(artifacts.id, artifact.id));
      await recordAudit(tx, {
        action: "artifact.visibility_changed",
        workspaceId: actor.workspaceId,
        actorUserId: actor.userId,
        targetType: "artifact",
        targetId: artifact.id,
        metadata: { from: "private", to: "unlisted" },
        ...meta,
      });
    }
    const [row] = await tx
      .insert(shareLinks)
      .values({
        workspaceId: actor.workspaceId,
        artifactId: artifact.id,
        tokenHash: hashShareToken(token),
        label,
        allowPreview: input.allowPreview,
        allowReading: input.allowReading,
        allowDownload: input.allowDownload,
        expiresAt,
        createdBy: actor.userId,
      })
      .returning(summaryColumns);
    await recordAudit(tx, {
      action: "share.created",
      workspaceId: actor.workspaceId,
      actorUserId: actor.userId,
      targetType: "artifact",
      targetId: artifact.id,
      metadata: {
        shareId: row!.id,
        allowPreview: input.allowPreview,
        allowReading: input.allowReading,
        allowDownload: input.allowDownload,
        expiresAt: expiresAt?.toISOString() ?? null,
      },
      ...meta,
    });
    return { share: summarize(row!, now), token, madeUnlisted };
  });
}

/** Revokes a link (idempotent); it stops working at once, previews included. */
export async function revokeShare(db: Database, actor: Actor, shareId: string, meta: RequestMeta) {
  return db.transaction(async (tx) => {
    const [link] = await tx
      .select({
        id: shareLinks.id,
        artifactId: shareLinks.artifactId,
        revokedAt: shareLinks.revokedAt,
      })
      .from(shareLinks)
      .where(and(eq(shareLinks.id, shareId), eq(shareLinks.workspaceId, actor.workspaceId)))
      .for("update");
    if (!link) throw notFound("Share link");
    if (link.revokedAt) return { revoked: true };
    await tx
      .update(shareLinks)
      .set({ revokedAt: new Date(), updatedAt: new Date() })
      .where(eq(shareLinks.id, link.id));
    await recordAudit(tx, {
      action: "share.revoked",
      workspaceId: actor.workspaceId,
      actorUserId: actor.userId,
      targetType: "artifact",
      targetId: link.artifactId,
      metadata: { shareId: link.id },
      ...meta,
    });
    return { revoked: true };
  });
}

/**
 * Sets an artifact's visibility (private or unlisted; public belongs to the showcase, Phase 4).
 * Making it private revokes every live link, so none can come back if it is unlisted again.
 */
export async function setVisibility(
  db: Database,
  actor: Actor,
  artifactId: string,
  visibility: ShareableVisibility,
  meta: RequestMeta,
): Promise<{ visibility: ShareableVisibility; revoked: number }> {
  return db.transaction(async (tx) => {
    const artifact = await lockArtifact(tx, actor, artifactId);
    if (artifact.visibility === visibility) return { visibility, revoked: 0 };
    const now = new Date();
    await tx
      .update(artifacts)
      .set({ visibility, updatedAt: now })
      .where(eq(artifacts.id, artifact.id));
    const revoked =
      visibility === "private"
        ? await tx
            .update(shareLinks)
            .set({ revokedAt: now, updatedAt: now })
            .where(and(eq(shareLinks.artifactId, artifact.id), isNull(shareLinks.revokedAt)))
            .returning({ id: shareLinks.id })
        : [];
    await recordAudit(tx, {
      action: "artifact.visibility_changed",
      workspaceId: actor.workspaceId,
      actorUserId: actor.userId,
      targetType: "artifact",
      targetId: artifact.id,
      metadata: { from: artifact.visibility, to: visibility, revokedShares: revoked.length },
      ...meta,
    });
    return { visibility, revoked: revoked.length };
  });
}

// ---------- pre-share check (FR-SHR-3) ----------

export interface ShareFinding {
  kind: "sensitive" | "secret" | "email" | "private_url" | "suspicious_file";
  count: number;
  /** Up to three masked examples, so the owner can find them. */
  samples: string[];
}

/** The checked text is capped: the scan is advisory, and must stay fast. */
const SCAN_MAX_CHARS = 2_000_000;

const SECRET_PATTERNS = [
  /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----/g,
  /\b(?:sk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,200}|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{22,255}|glpat-[A-Za-z0-9_-]{20,}|xox[abprs]-[A-Za-z0-9-]{10,200}|AIza[0-9A-Za-z_-]{35})\b/g,
  /\beyJ[A-Za-z0-9_-]{8,2000}\.[A-Za-z0-9_-]{8,4000}\.[A-Za-z0-9_-]{8,2000}/g,
];
const EMAIL = /[A-Za-z0-9._%+-]{1,64}@(?:[A-Za-z0-9-]{1,63}\.){1,8}[A-Za-z]{2,24}/g;
const PRIVATE_URL =
  /\bhttps?:\/\/(?:localhost|127(?:\.\d{1,3}){3}|10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}|(?:[A-Za-z0-9-]{1,63}\.){1,8}(?:local|internal|corp|lan|intranet))(?::\d{1,5})?\b/gi;
const SUSPICIOUS_FILE =
  /(?:^|\/)(?:\.env(?:\.[^/]*)?|\.git\/.*|\.npmrc|\.netrc|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|[^/]*\.(?:pem|key|p12|pfx|keystore|jks)|credentials(?:\.[^/]*)?|secrets?\.(?:json|ya?ml|toml|env))$/i;

/** Keeps the start and end of a match: enough to find it, not enough to reuse it. */
function mask(text: string): string {
  const chars = Array.from(text);
  if (chars.length <= 8) return `${chars[0] ?? ""}…`;
  return `${chars.slice(0, 4).join("")}…${chars.slice(-2).join("")}`;
}

function scan(kind: ShareFinding["kind"], text: string, patterns: RegExp[]): ShareFinding | null {
  const samples: string[] = [];
  let count = 0;
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      count += 1;
      if (samples.length < 3) samples.push(mask(match[0]));
    }
  }
  return count > 0 ? { kind, count, samples } : null;
}

/**
 * Advisory scan before sharing (FR-SHR-3): the artifact's text and metadata for what looks like
 * secrets, email addresses and private URLs, its preview files for files that usually hold
 * secrets, and its sensitivity. The owner decides; `blocked` is set only for restricted artifacts,
 * which are never shared.
 */
export async function checkShare(
  db: DbExecutor,
  actor: Actor,
  artifactId: string,
): Promise<{ findings: ShareFinding[]; blocked: boolean; visibility: string }> {
  const artifact = await getArtifactForActor(db, actor, artifactId);
  const findings: ShareFinding[] = [];
  if (artifact.sensitivity !== "normal") {
    findings.push({ kind: "sensitive", count: 1, samples: [artifact.sensitivity] });
  }
  let text = [artifact.title, artifact.summary ?? "", artifact.description ?? ""].join("\n");
  if (artifact.currentVersionId) {
    const [document] = await db
      .select({ text: sql<string>`left(${extractedDocuments.plainText}, ${SCAN_MAX_CHARS})` })
      .from(artifactVersions)
      .innerJoin(extractedDocuments, eq(extractedDocuments.id, artifactVersions.activeExtractionId))
      .where(
        and(
          eq(artifactVersions.id, artifact.currentVersionId),
          eq(artifactVersions.workspaceId, actor.workspaceId),
        ),
      );
    if (document?.text) text += `\n${document.text}`;
    const files = await db
      .select({ path: derivedAssets.path })
      .from(derivedAssets)
      .where(
        and(
          eq(derivedAssets.artifactVersionId, artifact.currentVersionId),
          eq(derivedAssets.workspaceId, actor.workspaceId),
          eq(derivedAssets.kind, "preview_file"),
        ),
      );
    const suspicious = files
      .map((file) => file.path ?? "")
      .filter((path) => SUSPICIOUS_FILE.test(path));
    if (suspicious.length > 0) {
      findings.push({
        kind: "suspicious_file",
        count: suspicious.length,
        samples: suspicious.slice(0, 3),
      });
    }
  }
  for (const finding of [
    scan("secret", text, SECRET_PATTERNS),
    scan("email", text, [EMAIL]),
    scan("private_url", text, [PRIVATE_URL]),
  ]) {
    if (finding) findings.push(finding);
  }
  return {
    findings,
    blocked: artifact.sensitivity === "restricted",
    visibility: artifact.visibility,
  };
}

// ---------- the public side ----------

/** What a valid link lets its holder do: one artifact, its current version, these permissions. */
export interface ShareCapability {
  linkId: string;
  workspaceId: string;
  artifactId: string;
  versionId: string | null;
  title: string;
  summary: string | null;
  allowPreview: boolean;
  allowReading: boolean;
  allowDownload: boolean;
  expiresAt: Date | null;
}

/** The conditions under which a link works, besides its token. */
const live = (now: Date) =>
  and(
    isNull(shareLinks.revokedAt),
    sql`(${shareLinks.expiresAt} is null or ${shareLinks.expiresAt} > ${now})`,
    isNull(artifacts.deletedAt),
    sql`${artifacts.visibility} <> 'private'`,
    sql`${artifacts.sensitivity} <> 'restricted'`,
  );

/**
 * The capability of a share token, or null for anything else: malformed, unknown, revoked,
 * expired, or an artifact that is private, deleted or restricted. Callers answer every null the
 * same way (404), so a holder learns nothing about why.
 */
export async function resolveShare(
  db: DbExecutor,
  token: string,
  now = new Date(),
): Promise<ShareCapability | null> {
  if (!TOKEN_PATTERN.test(token)) return null;
  const [row] = await db
    .select({
      linkId: shareLinks.id,
      workspaceId: shareLinks.workspaceId,
      artifactId: shareLinks.artifactId,
      versionId: artifacts.currentVersionId,
      title: artifacts.title,
      summary: artifacts.summary,
      allowPreview: shareLinks.allowPreview,
      allowReading: shareLinks.allowReading,
      allowDownload: shareLinks.allowDownload,
      expiresAt: shareLinks.expiresAt,
    })
    .from(shareLinks)
    .innerJoin(
      artifacts,
      and(
        eq(artifacts.id, shareLinks.artifactId),
        eq(artifacts.workspaceId, shareLinks.workspaceId),
      ),
    )
    .where(and(eq(shareLinks.tokenHash, hashShareToken(token)), live(now)));
  return row ?? null;
}

/** Counts a page view of the link (not every preview file it loads). */
export async function recordShareAccess(db: DbExecutor, linkId: string) {
  await db
    .update(shareLinks)
    .set({ accessCount: sql`${shareLinks.accessCount} + 1`, lastAccessedAt: new Date() })
    .where(eq(shareLinks.id, linkId));
}

/**
 * Whether a share-scoped preview token may still serve `versionId`: its link is live, allows
 * previews, and the version is its artifact's current one. Checked on every preview request,
 * so revoking a link (or making its artifact private) stops its previews at once.
 */
export async function shareAllowsPreview(
  db: DbExecutor,
  input: { linkId: string; versionId: string; workspaceId: string },
  now = new Date(),
): Promise<boolean> {
  if (!isUuid(input.linkId)) return false;
  const [row] = await db
    .select({ id: shareLinks.id })
    .from(shareLinks)
    .innerJoin(
      artifacts,
      and(
        eq(artifacts.id, shareLinks.artifactId),
        eq(artifacts.workspaceId, shareLinks.workspaceId),
      ),
    )
    .where(
      and(
        eq(shareLinks.id, input.linkId),
        eq(shareLinks.workspaceId, input.workspaceId),
        eq(shareLinks.allowPreview, true),
        eq(artifacts.currentVersionId, input.versionId),
        live(now),
      ),
    );
  return Boolean(row);
}

/** The current version's facts the shared page needs, read through the capability only. */
export async function shareVersion(db: DbExecutor, capability: ShareCapability) {
  if (!capability.versionId) return null;
  const [version] = await db
    .select({
      id: artifactVersions.id,
      contentKind: artifactVersions.contentKind,
      previewKind: artifactVersions.previewKind,
      previewStatus: artifactVersions.previewStatus,
      previewEntryPath: artifactVersions.previewEntryPath,
      processingStatus: artifactVersions.processingStatus,
      activeExtractionId: artifactVersions.activeExtractionId,
      storageKey: fileAssets.storageKey,
      originalFilename: fileAssets.originalFilename,
      mimeType: fileAssets.mimeType,
      byteSize: fileAssets.byteSize,
      sha256: fileAssets.sha256,
    })
    .from(artifactVersions)
    .innerJoin(fileAssets, eq(fileAssets.id, artifactVersions.primaryFileId))
    .where(
      and(
        eq(artifactVersions.id, capability.versionId),
        eq(artifactVersions.artifactId, capability.artifactId),
        eq(artifactVersions.workspaceId, capability.workspaceId),
      ),
    );
  return version ?? null;
}

/** Reading content of the shared version (the same shape reading mode takes), or null. */
export async function shareContent(
  db: DbExecutor,
  capability: ShareCapability,
  version: { contentKind: string; activeExtractionId: string | null },
) {
  if (!capability.allowReading || !version.activeExtractionId) return null;
  const [document] = await db
    .select({
      id: extractedDocuments.id,
      method: extractedDocuments.extractionMethod,
      status: extractedDocuments.status,
      title: extractedDocuments.title,
      language: extractedDocuments.language,
      markdown: extractedDocuments.normalizedMarkdown,
      warnings: extractedDocuments.warnings,
    })
    .from(extractedDocuments)
    .where(
      and(
        eq(extractedDocuments.id, version.activeExtractionId),
        eq(extractedDocuments.workspaceId, capability.workspaceId),
      ),
    );
  if (!document) return null;
  const sections = await db
    .select({
      ordinal: documentSections.ordinal,
      level: documentSections.level,
      heading: documentSections.heading,
      anchor: documentSections.anchor,
    })
    .from(documentSections)
    .where(eq(documentSections.extractedDocumentId, document.id))
    .orderBy(asc(documentSections.ordinal));
  const { id: _id, ...extraction } = document;
  return { contentKind: version.contentKind, extraction, sections };
}

/** The shared version's thumbnail (our own WebP), for reading or preview links. */
export async function shareThumbnail(db: DbExecutor, capability: ShareCapability) {
  if (!capability.versionId || !(capability.allowReading || capability.allowPreview)) return null;
  const [thumbnail] = await db
    .select({
      storageKey: derivedAssets.storageKey,
      byteSize: derivedAssets.byteSize,
      sha256: derivedAssets.sha256,
    })
    .from(derivedAssets)
    .where(
      and(
        eq(derivedAssets.artifactVersionId, capability.versionId),
        eq(derivedAssets.workspaceId, capability.workspaceId),
        eq(derivedAssets.kind, "thumbnail"),
      ),
    );
  return thumbnail ?? null;
}

/**
 * A preview URL for the link's holder, or null when the link does not allow previews or the
 * version has no site preview. The token names the link, so the preview route re-checks that
 * the link is live on every file; its lifetime is an hour at most and never outlasts the link.
 */
export async function issueSharePreviewUrl(
  db: DbExecutor,
  capability: ShareCapability,
  version: {
    id: string;
    previewKind: string;
    previewStatus: string;
    previewEntryPath: string | null;
  },
  env: { PREVIEW_ORIGIN: string; PREVIEW_TOKEN_SECRET: string },
  now = new Date(),
): Promise<{ url: string; expiresAt: Date; expiresInSeconds: number } | null> {
  if (
    !capability.allowPreview ||
    version.id !== capability.versionId ||
    version.previewStatus !== "ready" ||
    !version.previewEntryPath ||
    !SITE_PREVIEW_KINDS.has(version.previewKind)
  ) {
    return null;
  }
  const untilLinkExpires = capability.expiresAt
    ? Math.floor((capability.expiresAt.getTime() - now.getTime()) / 1000)
    : Number.POSITIVE_INFINITY;
  const ttlSeconds = Math.min(SHARE_PREVIEW_MAX_TTL_SECONDS, untilLinkExpires);
  if (ttlSeconds < 1) return null;
  const target = { versionId: version.id, workspaceId: capability.workspaceId };
  if (!(await findPreviewFile(db, target, version.previewEntryPath))) return null;
  const { token, expiresAt } = createPreviewToken(
    env.PREVIEW_TOKEN_SECRET,
    { ...target, shareLinkId: capability.linkId },
    now,
    ttlSeconds,
  );
  const encodedPath = version.previewEntryPath.split("/").map(encodeURIComponent).join("/");
  return {
    url: `${env.PREVIEW_ORIGIN}/p/${token}/${encodedPath}`,
    expiresAt,
    expiresInSeconds: ttlSeconds,
  };
}

// ---------- rate limiting for anonymous routes ----------

/** Requests one client address may make to share links (pages, thumbnails, downloads). */
export const SHARE_RATE_LIMIT = { limit: 120, windowSeconds: 60 };
/** Windows longer than this would be cut short by the cleanup job. */
const RATE_LIMIT_MAX_WINDOW_SECONDS = 60 * 60;
export const RATE_LIMIT_CLEANUP_JOB_TYPE = "maintenance.cleanup_rate_limits";

/**
 * Counts one request against `key` in a fixed window; false once the window holds more than
 * `limit` requests. One atomic upsert per request, so concurrent requests count exactly.
 */
export async function withinRateLimit(
  db: DbExecutor,
  key: string,
  limit: number,
  windowSeconds: number,
): Promise<boolean> {
  if (windowSeconds <= 0 || windowSeconds > RATE_LIMIT_MAX_WINDOW_SECONDS) {
    throw new Error(`Rate-limit windows are 1–${RATE_LIMIT_MAX_WINDOW_SECONDS} seconds`);
  }
  const expired = sql`${rateLimitBuckets.windowStart} <= now() - make_interval(secs => ${windowSeconds})`;
  const [bucket] = await db
    .insert(rateLimitBuckets)
    .values({ key, windowStart: sql`now()`, count: 1 })
    .onConflictDoUpdate({
      target: rateLimitBuckets.key,
      set: {
        count: sql`case when ${expired} then 1 else ${rateLimitBuckets.count} + 1 end`,
        windowStart: sql`case when ${expired} then now() else ${rateLimitBuckets.windowStart} end`,
      },
    })
    .returning({ count: rateLimitBuckets.count });
  return (bucket?.count ?? 0) <= limit;
}

/** Deletes counters whose window ended long ago (one row per client address otherwise stays). */
export async function deleteStaleRateLimits(db: DbExecutor): Promise<number> {
  const result = await db
    .delete(rateLimitBuckets)
    .where(
      sql`${rateLimitBuckets.windowStart} < now() - make_interval(secs => ${RATE_LIMIT_MAX_WINDOW_SECONDS})`,
    );
  return result.rowCount ?? 0;
}

/**
 * Hourly cleanup of rate-limit counters. Idempotent: it only deletes windows that ended over an
 * hour ago, which no request counts against any more, so running it twice changes nothing.
 */
export function rateLimitCleanupJobDefinition(): JobDefinition {
  return {
    type: RATE_LIMIT_CLEANUP_JOB_TYPE,
    timeoutMs: 60 * 1000,
    handler: async ({ db }) => ({ deleted: await deleteStaleRateLimits(db) }),
  };
}
