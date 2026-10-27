import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { GET as previewRoute } from "@/app/p/[token]/[...path]/route";
import { GET as downloadRoute } from "@/app/s/[token]/download/route";
import { POST as previewTokenRoute } from "@/app/s/[token]/preview-token/route";
import { GET as thumbnailRoute } from "@/app/s/[token]/thumbnail/route";
import { getEnv } from "@/infrastructure/config/env";
import { closeDb } from "@/infrastructure/database/client";
import {
  artifacts,
  artifactVersions,
  auditLogs,
  rateLimitBuckets,
  shareLinks,
} from "@/infrastructure/database/schema";
import { newId } from "@/lib/ids";
import type { Actor } from "@/modules/auth";
import {
  checkShare,
  createShare,
  deleteStaleRateLimits,
  hashShareToken,
  issueSharePreviewUrl,
  listShares,
  recordShareAccess,
  resolveShare,
  revokeShare,
  setVisibility,
  SHARE_RATE_LIMIT,
  shareAllowsPreview,
  shareContent,
  shareVersion,
  withinRateLimit,
  type CreateShareInput,
} from "@/modules/sharing";
import { claudeDesignZipEntries, htmlDocument, pngImage } from "@tests/fixtures/builders";
import { buildZip } from "@tests/fixtures/zip";
import { uniqueIp } from "../helpers/auth";
import { closeTestDb, testDb } from "../helpers/db";
import { createTestActor, drainJobs, newBatch, uploadFile } from "../helpers/imports";

const db = testDb();
const env = getEnv();
const meta = { ipAddress: null, userAgent: "vitest" };
const ALL: CreateShareInput = { allowPreview: true, allowReading: true, allowDownload: true };

afterAll(async () => {
  await closeDb();
  await closeTestDb();
});

async function importOne(actor: Actor, filename: string, bytes: Buffer | string) {
  const item = await uploadFile(actor, (await newBatch(actor)).id, { filename, bytes });
  await drainJobs();
  const [version] = await db
    .select({ id: artifactVersions.id, artifactId: artifactVersions.artifactId })
    .from(artifactVersions)
    .where(eq(artifactVersions.importItemId, item.id));
  return { artifactId: version!.artifactId, versionId: version!.id };
}

const share = (actor: Actor, artifactId: string, input: Partial<CreateShareInput> = {}) =>
  createShare(db, actor, artifactId, { ...ALL, ...input }, meta);

/** A request from one client address (the rate limit counts per address). */
const publicRequest = (path: string, ip: string, method = "GET") =>
  new Request(`${env.APP_ORIGIN}${path}`, { method, headers: { "x-forwarded-for": ip } });
const tokenParams = (token: string) => ({ params: Promise.resolve({ token }) });

async function artifactRow(artifactId: string) {
  const [row] = await db
    .select({ visibility: artifacts.visibility })
    .from(artifacts)
    .where(eq(artifacts.id, artifactId));
  return row!;
}

describe("share links (FR-SHR, SECURITY.md §7)", () => {
  it("creates a link: the token is returned once and only its hash is stored", async () => {
    const owner = await createTestActor();
    const note = await importOne(owner, "share.html", htmlDocument({ title: "分享測試" }));
    expect((await artifactRow(note.artifactId)).visibility).toBe("private");

    const created = await share(owner, note.artifactId, { label: "  給同事  " });
    expect(created.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(created.madeUnlisted).toBe(true);
    expect(created.share).toMatchObject({ label: "給同事", active: true, accessCount: 0 });
    expect((await artifactRow(note.artifactId)).visibility).toBe("unlisted");

    const [stored] = await db.select().from(shareLinks).where(eq(shareLinks.id, created.share.id));
    expect(stored!.tokenHash).toBe(createHash("sha256").update(created.token).digest("hex"));
    expect(JSON.stringify(stored)).not.toContain(created.token);
    const audits = await db
      .select({ action: auditLogs.action, metadata: auditLogs.metadata })
      .from(auditLogs)
      .where(eq(auditLogs.targetId, note.artifactId));
    expect(audits.map((row) => row.action).sort()).toEqual([
      "artifact.visibility_changed",
      "share.created",
    ]);
    expect(JSON.stringify(audits)).not.toContain(created.token);

    const capability = await resolveShare(db, created.token);
    expect(capability).toMatchObject({
      linkId: created.share.id,
      artifactId: note.artifactId,
      versionId: note.versionId,
      workspaceId: owner.workspaceId,
      title: "分享測試",
    });
    // A second link leaves the visibility alone.
    expect((await share(owner, note.artifactId)).madeUnlisted).toBe(false);
    expect((await listShares(db, owner, note.artifactId)).map((row) => row.id)).toHaveLength(2);
  });

  it("resolves nothing for malformed, unknown or near-miss tokens", async () => {
    const owner = await createTestActor();
    const note = await importOne(owner, "near.html", htmlDocument({ title: "近似" }));
    const { token } = await share(owner, note.artifactId);
    const flipped = `${token.slice(0, 10)}${token[10] === "A" ? "B" : "A"}${token.slice(11)}`;
    for (const candidate of [
      "",
      "short",
      `${token}x`,
      token.slice(0, -1),
      `${token.slice(0, -1)}=`,
      flipped,
      hashShareToken(token),
      token.toLowerCase() === token ? token.toUpperCase() : token.toLowerCase(),
    ]) {
      expect(await resolveShare(db, candidate), candidate).toBeNull();
    }
  });

  it("validates options and refuses restricted artifacts", async () => {
    const owner = await createTestActor();
    const note = await importOne(owner, "rules.html", htmlDocument({ title: "規則" }));
    const now = new Date();
    const day = 24 * 60 * 60 * 1000;
    for (const input of [
      { allowPreview: false, allowReading: false, allowDownload: false },
      { expiresAt: new Date(now.getTime() - 1000) },
      { expiresAt: new Date(now.getTime() + 366 * day) },
      { label: "標".repeat(101) },
      { label: "a\u0000b" },
    ]) {
      await expect(
        share(owner, note.artifactId, input),
        JSON.stringify(input),
      ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    }
    expect(
      (
        await share(owner, note.artifactId, {
          expiresAt: new Date(now.getTime() + 365 * day - 60_000),
        })
      ).share.active,
    ).toBe(true);

    const secret = await importOne(owner, "secret.html", htmlDocument({ title: "限制" }));
    await db
      .update(artifacts)
      .set({ sensitivity: "restricted" })
      .where(eq(artifacts.id, secret.artifactId));
    await expect(share(owner, secret.artifactId)).rejects.toMatchObject({
      code: "CONFLICT",
      details: { reason: "RESTRICTED" },
    });
    expect((await artifactRow(secret.artifactId)).visibility).toBe("private");
    expect(await listShares(db, owner, secret.artifactId)).toEqual([]);
    expect((await checkShare(db, owner, secret.artifactId)).blocked).toBe(true);
  });

  it("stops working when revoked, expired, made private, restricted or deleted", async () => {
    const owner = await createTestActor();
    const make = async (name: string) => {
      const ids = await importOne(owner, `${name}.html`, htmlDocument({ title: name }));
      return { ...ids, ...(await share(owner, ids.artifactId)) };
    };

    const revoked = await make("revoked");
    await revokeShare(db, owner, revoked.share.id, meta);
    await revokeShare(db, owner, revoked.share.id, meta); // idempotent
    expect(await resolveShare(db, revoked.token)).toBeNull();
    expect((await listShares(db, owner, revoked.artifactId))[0]).toMatchObject({
      active: false,
      revokedAt: expect.any(Date) as unknown,
    });

    const expiring = await make("expiring");
    const [link] = await db
      .update(shareLinks)
      .set({ expiresAt: new Date(Date.now() + 60 * 60 * 1000) })
      .where(eq(shareLinks.id, expiring.share.id))
      .returning();
    expect(await resolveShare(db, expiring.token)).not.toBeNull();
    expect(
      await resolveShare(db, expiring.token, new Date(link!.expiresAt!.getTime() + 1)),
    ).toBeNull();

    const madePrivate = await make("private");
    const second = await share(owner, madePrivate.artifactId);
    expect(await setVisibility(db, owner, madePrivate.artifactId, "private", meta)).toEqual({
      visibility: "private",
      revoked: 2,
    });
    expect(await resolveShare(db, madePrivate.token)).toBeNull();
    // Unlisting it again never brings old links back.
    await setVisibility(db, owner, madePrivate.artifactId, "unlisted", meta);
    expect(await resolveShare(db, second.token)).toBeNull();

    // Changed behind the module's back: the resolver checks the artifact's state itself.
    const restricted = await make("restricted");
    await db
      .update(artifacts)
      .set({ sensitivity: "restricted" })
      .where(eq(artifacts.id, restricted.artifactId));
    expect(await resolveShare(db, restricted.token)).toBeNull();

    const hidden = await make("hidden");
    await db
      .update(artifacts)
      .set({ visibility: "private" })
      .where(eq(artifacts.id, hidden.artifactId));
    expect(await resolveShare(db, hidden.token)).toBeNull();

    const deleted = await make("deleted");
    await db
      .update(artifacts)
      .set({ deletedAt: new Date() })
      .where(eq(artifacts.id, deleted.artifactId));
    expect(await resolveShare(db, deleted.token)).toBeNull();
  });

  it("is managed only within the owner's workspace", async () => {
    const owner = await createTestActor();
    const stranger = await createTestActor();
    const note = await importOne(owner, "mine.html", htmlDocument({ title: "我的" }));
    const { share: link, token } = await share(owner, note.artifactId);
    await expect(share(stranger, note.artifactId)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(listShares(db, stranger, note.artifactId)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(revokeShare(db, stranger, link.id, meta)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(revokeShare(db, owner, "not-a-uuid", meta)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(
      setVisibility(db, stranger, note.artifactId, "private", meta),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(checkShare(db, stranger, note.artifactId)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(await resolveShare(db, token)).not.toBeNull();
  });

  it("reads only what the link allows, of the current version", async () => {
    const owner = await createTestActor();
    const note = await importOne(owner, "read.html", htmlDocument({ title: "閱讀權限" }));
    const readable = await resolveShare(db, (await share(owner, note.artifactId)).token);
    const version = await shareVersion(db, readable!);
    expect(version).toMatchObject({ id: note.versionId, contentKind: "html_document" });
    expect((await shareContent(db, readable!, version!))?.extraction.markdown).toContain(
      "城市沒有恆溫器",
    );

    const downloadOnly = await resolveShare(
      db,
      (await share(owner, note.artifactId, { allowReading: false, allowPreview: false })).token,
    );
    expect(await shareContent(db, downloadOnly!, version!)).toBeNull();

    // A capability for one artifact never reads another's version.
    const other = await importOne(owner, "other.html", htmlDocument({ title: "另一份" }));
    expect(await shareVersion(db, { ...readable!, versionId: other.versionId })).toBeNull();
  });

  it("finds what looks sensitive before sharing", async () => {
    const owner = await createTestActor();
    const key = `AK${"IA"}ABCDEFGHIJKLMNOP`;
    const note = await importOne(
      owner,
      "leaky.html",
      htmlDocument({
        title: "內部筆記",
        body: `<p>聯絡 alice@example.com，金鑰 ${key}，系統 http://wiki.internal/a</p>`,
      }),
    );
    const result = await checkShare(db, owner, note.artifactId);
    expect(result.blocked).toBe(false);
    expect(result.visibility).toBe("private");
    expect(result.findings.map((finding) => finding.kind).sort()).toEqual([
      "email",
      "private_url",
      "secret",
    ]);
    expect(JSON.stringify(result)).not.toContain(key);

    await db
      .update(artifacts)
      .set({ sensitivity: "sensitive" })
      .where(eq(artifacts.id, note.artifactId));
    expect((await checkShare(db, owner, note.artifactId)).findings[0]).toEqual({
      kind: "sensitive",
      count: 1,
      samples: ["sensitive"],
    });
  });

  it("counts page views", async () => {
    const owner = await createTestActor();
    const note = await importOne(owner, "views.html", htmlDocument({ title: "瀏覽" }));
    const { token } = await share(owner, note.artifactId);
    const capability = await resolveShare(db, token);
    await recordShareAccess(db, capability!.linkId);
    await recordShareAccess(db, capability!.linkId);
    expect((await listShares(db, owner, note.artifactId))[0]).toMatchObject({
      accessCount: 2,
      lastAccessedAt: expect.any(Date) as unknown,
    });
  });
});

describe("shared previews (SECURITY.md §5)", () => {
  const fetchPreview = (url: string) =>
    previewRoute(new Request(url, { headers: { host: new URL(url).host } }));

  it("serve through a share-scoped token that stops with its link", async () => {
    const owner = await createTestActor();
    const site = await importOne(owner, "site.zip", buildZip(await claudeDesignZipEntries("共享")));
    const created = await share(owner, site.artifactId);
    const capability = await resolveShare(db, created.token);
    const version = await shareVersion(db, capability!);
    const preview = await issueSharePreviewUrl(db, capability!, version!, env);
    expect(preview!.url.startsWith(`${env.PREVIEW_ORIGIN}/p/`)).toBe(true);
    expect(preview!.expiresInSeconds).toBe(3600);
    expect((await fetchPreview(preview!.url)).status).toBe(200);

    const target = {
      linkId: created.share.id,
      versionId: site.versionId,
      workspaceId: owner.workspaceId,
    };
    expect(await shareAllowsPreview(db, target)).toBe(true);
    expect(await shareAllowsPreview(db, { ...target, workspaceId: newId() })).toBe(false);
    expect(await shareAllowsPreview(db, { ...target, versionId: newId() })).toBe(false);
    expect(await shareAllowsPreview(db, { ...target, linkId: "nope" })).toBe(false);

    await revokeShare(db, owner, created.share.id, meta);
    // Same unexpired token: the link is checked on every file.
    const refused = await fetchPreview(preview!.url);
    expect(refused.status).toBe(404);
    expect(await refused.text()).toBe("Not found");
  });

  it("are not issued without permission, and never outlive their link", async () => {
    const owner = await createTestActor();
    const site = await importOne(
      owner,
      "site2.zip",
      buildZip(await claudeDesignZipEntries("期限")),
    );
    const noPreview = await resolveShare(
      db,
      (await share(owner, site.artifactId, { allowPreview: false })).token,
    );
    expect(
      await issueSharePreviewUrl(db, noPreview!, (await shareVersion(db, noPreview!))!, env),
    ).toBeNull();
    const target = {
      linkId: noPreview!.linkId,
      versionId: site.versionId,
      workspaceId: owner.workspaceId,
    };
    expect(await shareAllowsPreview(db, target)).toBe(false);

    const soon = await resolveShare(
      db,
      (await share(owner, site.artifactId, { expiresAt: new Date(Date.now() + 10 * 60_000) }))
        .token,
    );
    const preview = await issueSharePreviewUrl(db, soon!, (await shareVersion(db, soon!))!, env);
    expect(preview!.expiresInSeconds).toBeLessThanOrEqual(600);
    expect(preview!.expiresInSeconds).toBeGreaterThan(590);
    expect(preview!.expiresAt.getTime()).toBeLessThanOrEqual(soon!.expiresAt!.getTime());
  });
});

describe("public share routes", () => {
  it("download the original only when the link allows it, audited", async () => {
    const owner = await createTestActor();
    const note = await importOne(owner, "dl.html", htmlDocument({ title: "下載" }));
    const ip = uniqueIp();
    const reading = await share(owner, note.artifactId, { allowDownload: false });
    const refused = await downloadRoute(
      publicRequest(`/s/${reading.token}/download`, ip),
      tokenParams(reading.token),
    );
    expect(refused.status).toBe(404);
    expect(refused.headers.get("referrer-policy")).toBe("no-referrer");

    const full = await share(owner, note.artifactId);
    const response = await downloadRoute(
      publicRequest(`/s/${full.token}/download`, ip),
      tokenParams(full.token),
    );
    expect(response.status).toBe(302);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const version = await shareVersion(db, (await resolveShare(db, full.token))!);
    expect(response.headers.get("x-content-sha256")).toBe(version!.sha256);
    const [audit] = await db
      .select({ actor: auditLogs.actorUserId, metadata: auditLogs.metadata })
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.action, "share.original.downloaded"),
          eq(auditLogs.targetId, note.versionId),
        ),
      );
    expect(audit).toEqual({
      actor: null,
      metadata: { shareId: full.share.id, sha256: version!.sha256 },
    });

    for (const token of ["nope", hashShareToken(full.token).slice(0, 43)]) {
      const unknown = await downloadRoute(
        publicRequest(`/s/${token}/download`, ip),
        tokenParams(token),
      );
      expect(unknown.status).toBe(404);
      expect(await unknown.text()).toBe("Not found");
    }
  });

  it("serve the thumbnail and fresh preview URLs to the link's holder", async () => {
    const owner = await createTestActor();
    const image = await importOne(owner, "photo.png", await pngImage());
    const ip = uniqueIp();
    const { token } = await share(owner, image.artifactId);
    const thumbnail = await thumbnailRoute(
      publicRequest(`/s/${token}/thumbnail`, ip),
      tokenParams(token),
    );
    expect(thumbnail.status).toBe(200);
    expect(thumbnail.headers.get("content-type")).toBe("image/webp");
    expect(
      Buffer.from(await thumbnail.arrayBuffer())
        .subarray(8, 12)
        .toString(),
    ).toBe("WEBP");
    // An image has no site preview.
    const noPreview = await previewTokenRoute(
      publicRequest(`/s/${token}/preview-token`, ip, "POST"),
      tokenParams(token),
    );
    expect(noPreview.status).toBe(404);

    const site = await importOne(
      owner,
      "site3.zip",
      buildZip(await claudeDesignZipEntries("刷新")),
    );
    const siteShare = await share(owner, site.artifactId);
    const minted = await previewTokenRoute(
      publicRequest(`/s/${siteShare.token}/preview-token`, ip, "POST"),
      tokenParams(siteShare.token),
    );
    expect(minted.status).toBe(200);
    const body = (await minted.json()) as { url: string; expiresInSeconds: number };
    expect(body.url.startsWith(`${env.PREVIEW_ORIGIN}/p/`)).toBe(true);
    expect(body.expiresInSeconds).toBe(3600);
  });

  it("rate-limits each client address", async () => {
    const owner = await createTestActor();
    const note = await importOne(owner, "busy.html", htmlDocument({ title: "頻繁" }));
    const { token } = await share(owner, note.artifactId, { allowDownload: false });
    const ip = uniqueIp();
    const hit = (from: string) =>
      downloadRoute(publicRequest(`/s/${token}/download`, from), tokenParams(token));
    for (let i = 0; i < SHARE_RATE_LIMIT.limit; i += 1) expect((await hit(ip)).status).toBe(404);
    const limited = await hit(ip);
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe(String(SHARE_RATE_LIMIT.windowSeconds));
    // Unknown tokens count too, and other addresses are not affected.
    expect((await downloadRoute(publicRequest("/s/x/download", ip), tokenParams("x"))).status).toBe(
      429,
    );
    expect((await hit(uniqueIp())).status).toBe(404);
  });
});

describe("rate-limit counters", () => {
  it("count exactly under concurrency and start over when the window ends", async () => {
    const key = `test:${newId()}`;
    const results = await Promise.all(
      Array.from({ length: 20 }, () => withinRateLimit(db, key, 15, 60)),
    );
    expect(results.filter(Boolean)).toHaveLength(15);
    const [bucket] = await db.select().from(rateLimitBuckets).where(eq(rateLimitBuckets.key, key));
    expect(bucket!.count).toBe(20);

    await db
      .update(rateLimitBuckets)
      .set({ windowStart: sql`now() - interval '61 seconds'` })
      .where(eq(rateLimitBuckets.key, key));
    expect(await withinRateLimit(db, key, 15, 60)).toBe(true);
    const [restarted] = await db
      .select()
      .from(rateLimitBuckets)
      .where(eq(rateLimitBuckets.key, key));
    expect(restarted!.count).toBe(1);
    await expect(withinRateLimit(db, key, 1, 0)).rejects.toThrow();
    await expect(withinRateLimit(db, key, 1, 3601)).rejects.toThrow();
  });

  it("are cleaned up once their window is long over", async () => {
    const stale = `test:${newId()}`;
    const fresh = `test:${newId()}`;
    await withinRateLimit(db, stale, 5, 60);
    await withinRateLimit(db, fresh, 5, 60);
    await db
      .update(rateLimitBuckets)
      .set({ windowStart: sql`now() - interval '2 hours'` })
      .where(eq(rateLimitBuckets.key, stale));
    expect(await deleteStaleRateLimits(db)).toBeGreaterThanOrEqual(1);
    const keys = (await db.select({ key: rateLimitBuckets.key }).from(rateLimitBuckets)).map(
      (row) => row.key,
    );
    expect(keys).toContain(fresh);
    expect(keys).not.toContain(stale);
  });
});
