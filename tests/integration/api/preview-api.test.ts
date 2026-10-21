import { and, eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { POST as previewTokenRoute } from "@/app/api/artifacts/[id]/versions/[versionId]/preview-token/route";
import { HEAD as previewHead, GET as previewRoute } from "@/app/p/[token]/[...path]/route";
import { getEnv } from "@/infrastructure/config/env";
import { closeDb } from "@/infrastructure/database/client";
import { artifacts, artifactVersions, derivedAssets } from "@/infrastructure/database/schema";
import { getStorage, storageKeys } from "@/infrastructure/storage";
import { newId } from "@/lib/ids";
import { createPreviewToken } from "@/modules/preview";
import {
  claudeDesignZipEntries,
  htmlDocument,
  markdownDocument,
  pdfDocument,
} from "@tests/fixtures/builders";
import { buildZip } from "@tests/fixtures/zip";
import { createTestAdmin, signInOk } from "../helpers/auth";
import { closeTestDb, testDb } from "../helpers/db";
import { drainJobs, newBatch, uploadFile } from "../helpers/imports";

const db = testDb();
const env = getEnv();

afterAll(async () => {
  await closeDb();
  await closeTestDb();
});

const params = <T>(value: T) => ({ params: Promise.resolve(value) });

async function loggedIn() {
  const admin = await createTestAdmin();
  const { cookie } = await signInOk(admin.email, admin.password);
  const actor = {
    userId: admin.userId,
    workspaceId: admin.workspaceId,
    role: "owner" as const,
    sessionId: newId(),
    email: admin.email,
    name: "Owner",
  };
  return { ...admin, cookie, actor };
}

type Owner = Awaited<ReturnType<typeof loggedIn>>;

/** Imports one file and returns its artifact and (only) version ids. */
async function importOne(owner: Owner, filename: string, bytes: Buffer | string) {
  const item = await uploadFile(owner.actor, (await newBatch(owner.actor)).id, {
    filename,
    bytes,
  });
  await drainJobs();
  const [version] = await db
    .select({ id: artifactVersions.id, artifactId: artifactVersions.artifactId })
    .from(artifactVersions)
    .where(eq(artifactVersions.importItemId, item.id));
  return { artifactId: version!.artifactId, versionId: version!.id };
}

async function issue(owner: Pick<Owner, "cookie">, ids: { artifactId: string; versionId: string }) {
  const path = `/api/artifacts/${ids.artifactId}/versions/${ids.versionId}/preview-token`;
  return previewTokenRoute(
    new Request(`${env.APP_ORIGIN}${path}`, {
      method: "POST",
      headers: { origin: env.APP_ORIGIN, cookie: owner.cookie },
    }),
    params({ id: ids.artifactId, versionId: ids.versionId }),
  );
}

async function issueUrl(owner: Owner, ids: { artifactId: string; versionId: string }) {
  const response = await issue(owner, ids);
  expect(response.status).toBe(200);
  return ((await response.json()) as { url: string; expiresAt: string }).url;
}

/** A request as the browser sends it to the preview origin (Host = preview host). */
const fetchPreview = (url: string, headers: Record<string, string> = {}) =>
  previewRoute(new Request(url, { headers: { host: new URL(url).host, ...headers } }));
const headPreview = (url: string) =>
  previewHead(new Request(url, { method: "HEAD", headers: { host: new URL(url).host } }));

const tokenOf = (url: string) => new URL(url).pathname.split("/")[2]!;

describe("preview origin (SECURITY.md §5)", () => {
  it("issues a 15-minute URL on PREVIEW_ORIGIN and serves the site's files with strict headers", async () => {
    const owner = await loggedIn();
    const site = await importOne(
      owner,
      "preview-site.zip",
      buildZip(await claudeDesignZipEntries("預覽測試報告")),
    );

    const response = await issue(owner, site);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = (await response.json()) as {
      url: string;
      expiresAt: string;
      expiresInSeconds: number;
    };
    expect(body.expiresInSeconds).toBe(15 * 60);
    expect(body.url.startsWith(`${env.PREVIEW_ORIGIN}/p/`)).toBe(true);
    expect(body.url.endsWith("/Urban%20Heat%20Report.dc.html")).toBe(true);
    const ttl = Date.parse(body.expiresAt) - Date.now();
    expect(ttl).toBeGreaterThan(14 * 60_000);
    expect(ttl).toBeLessThanOrEqual(15 * 60_000);

    const entry = await fetchPreview(body.url);
    expect(entry.status).toBe(200);
    expect(entry.headers.get("content-type")).toBe("text/html");
    const csp = entry.headers.get("content-security-policy")!;
    expect(csp).toContain("script-src 'none'");
    expect(csp).toContain(`frame-ancestors ${env.APP_ORIGIN}`);
    expect(csp).toContain("sandbox allow-same-origin");
    expect(entry.headers.get("x-content-type-options")).toBe("nosniff");
    expect(entry.headers.get("referrer-policy")).toBe("no-referrer");
    expect(entry.headers.get("cache-control")).toBe("private, max-age=300");
    const html = await entry.text();
    expect(html).toContain("預覽測試報告");
    expect(entry.headers.get("content-length")).toBe(String(Buffer.byteLength(html)));

    // Relative references resolve inside the same token; scripts are only ever plain text.
    const script = await fetchPreview(new URL("support.js", body.url).href);
    expect(script.status).toBe(200);
    expect(script.headers.get("content-type")).toBe("text/plain");
    const bundle = await fetchPreview(new URL("_ds/modernist/_ds_bundle.js", body.url).href);
    expect(bundle.headers.get("content-type")).toBe("text/plain");
    const css = await fetchPreview(new URL("_ds/modernist/styles.css", body.url).href);
    expect(css.headers.get("content-type")).toBe("text/css");
    expect(await css.text()).toContain("--color-bg");

    // Conditional requests revalidate cheaply.
    const etag = entry.headers.get("etag")!;
    expect(etag).toMatch(/^"[0-9a-f]{64}"$/);
    const cached = await fetchPreview(body.url, { "if-none-match": etag });
    expect(cached.status).toBe(304);
    expect(await cached.text()).toBe("");

    // HEAD answers from the manifest without opening the stored object.
    const head = await headPreview(body.url);
    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toBe(String(Buffer.byteLength(html)));
    expect(head.headers.get("content-security-policy")).toBe(csp);
    expect(head.body).toBeNull();
  });

  it("does not offer a site preview for a ZIP that only holds a PDF", async () => {
    const owner = await loggedIn();
    const zip = await importOne(
      owner,
      "pdf-only.zip",
      buildZip([{ name: "report.pdf", data: pdfDocument() }]),
    );
    const [version] = await db
      .select({ previewKind: artifactVersions.previewKind })
      .from(artifactVersions)
      .where(eq(artifactVersions.id, zip.versionId));
    expect(version?.previewKind).toBe("pdf");
    expect((await issue(owner, zip)).status).toBe(404);
  });

  it("serves only preview files, and a row whose object is gone as 404", async () => {
    const owner = await loggedIn();
    const note = await importOne(owner, "kinds.html", htmlDocument({ title: "種類" }));
    const url = await issueUrl(owner, note);
    // A derived asset of another kind at a requestable path must not be served here.
    const thumbId = newId();
    const thumbKey = storageKeys.derived(owner.workspaceId, note.versionId, thumbId);
    await getStorage().putObject(thumbKey, Buffer.from("not a preview file"));
    await db.insert(derivedAssets).values({
      id: thumbId,
      workspaceId: owner.workspaceId,
      artifactVersionId: note.versionId,
      kind: "thumbnail",
      path: "thumb.webp",
      storageKey: thumbKey,
      mimeType: "image/webp",
      byteSize: 18,
      sha256: "0".repeat(64),
      generator: "test",
      generatorVersion: 1,
    });
    expect((await fetchPreview(new URL("thumb.webp", url).href)).status).toBe(404);

    const [entry] = await db
      .select({ storageKey: derivedAssets.storageKey })
      .from(derivedAssets)
      .where(
        and(
          eq(derivedAssets.artifactVersionId, note.versionId),
          eq(derivedAssets.kind, "preview_file"),
        ),
      );
    await getStorage().deleteObject(entry!.storageKey);
    const gone = await fetchPreview(url);
    expect(gone.status).toBe(404);
    expect(await gone.text()).toBe("Not found");
  });

  it("serves a single HTML file as index.html", async () => {
    const owner = await loggedIn();
    const note = await importOne(owner, "研究 筆記.html", htmlDocument({ title: "單檔預覽" }));
    const url = await issueUrl(owner, note);
    expect(url.endsWith("/index.html")).toBe(true);
    const response = await fetchPreview(url);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("單檔預覽");
  });

  it("answers every refusal with the same bare 404", async () => {
    const owner = await loggedIn();
    const site = await importOne(
      owner,
      "refusals.zip",
      buildZip(await claudeDesignZipEntries("拒絕測試")),
    );
    const note = await importOne(owner, "other.html", htmlDocument({ title: "另一份" }));
    const url = await issueUrl(owner, site);
    const token = tokenOf(url);
    const base = `${env.PREVIEW_ORIGIN}/p/${token}`;
    const tokenFor = (target: { versionId: string; workspaceId: string }, now = new Date()) =>
      createPreviewToken(env.PREVIEW_TOKEN_SECRET, target, now).token;
    // Change a character inside the MAC: the last base64url character carries padding bits,
    // so changing it can leave the decoded MAC unchanged.
    const at = token.indexOf(".") + 10;
    const flipped = `${token.slice(0, at)}${token[at] === "A" ? "B" : "A"}${token.slice(at + 1)}`;

    const refused: [string, string][] = [
      ["tampered token", `${env.PREVIEW_ORIGIN}/p/${flipped}/support.js`],
      ["no token", `${env.PREVIEW_ORIGIN}/p/`],
      ["no path", `${base}/`],
      ["unknown file", `${base}/nope.html`],
      ["encoded slash alias", `${base}/_ds%2Fmodernist%2Fstyles.css`],
      ["encoded traversal", `${base}/_ds/..%2Fsupport.js`],
      ["backslash", `${base}/_ds%5Cmodernist%5Cstyles.css`],
      ["NUL byte", `${base}/support.js%00.html`],
      ["broken encoding", `${base}/%E0%A4%A`],
      [
        "expired token",
        `${env.PREVIEW_ORIGIN}/p/${tokenFor(
          { versionId: site.versionId, workspaceId: owner.workspaceId },
          new Date(Date.now() - 16 * 60_000),
        )}/support.js`,
      ],
      [
        "another version's token",
        `${env.PREVIEW_ORIGIN}/p/${tokenFor({
          versionId: note.versionId,
          workspaceId: owner.workspaceId,
        })}/support.js`,
      ],
      [
        "version bound to another workspace",
        `${env.PREVIEW_ORIGIN}/p/${tokenFor({
          versionId: site.versionId,
          workspaceId: newId(),
        })}/support.js`,
      ],
    ];
    for (const [name, target] of refused) {
      const response = await fetchPreview(target);
      expect(response.status, name).toBe(404);
      expect(await response.text(), name).toBe("Not found");
      expect(response.headers.get("content-security-policy"), name).toContain("sandbox");
    }

    // The same valid URL is refused when it reaches the app host (defense behind proxy.ts).
    const appHost = new URL(env.APP_ORIGIN).host;
    const onAppHost = await previewRoute(new Request(url, { headers: { host: appHost } }));
    expect(onAppHost.status).toBe(404);
    expect((await fetchPreview(url)).status).toBe(200);
  });

  it("stops serving a deleted artifact at once, even for live tokens", async () => {
    const owner = await loggedIn();
    const note = await importOne(owner, "to-delete.html", htmlDocument({ title: "將刪除" }));
    const url = await issueUrl(owner, note);
    expect((await fetchPreview(url)).status).toBe(200);
    await db
      .update(artifacts)
      .set({ deletedAt: new Date() })
      .where(and(eq(artifacts.id, note.artifactId), eq(artifacts.workspaceId, owner.workspaceId)));
    expect((await fetchPreview(url)).status).toBe(404);
    expect((await issue(owner, note)).status).toBe(404);
  });

  it("issues tokens only for the owner's versions that have a preview", async () => {
    const owner = await loggedIn();
    const site = await importOne(owner, "mine.html", htmlDocument({ title: "我的作品" }));
    const markdown = await importOne(owner, "notes.md", markdownDocument());

    const none = await issue(owner, markdown);
    expect(none.status).toBe(404);
    expect(((await none.json()) as { error: { code: string } }).error.code).toBe("NOT_FOUND");

    const stranger = await loggedIn();
    expect((await issue(stranger, site)).status).toBe(404);
    expect((await issue(owner, { ...site, versionId: markdown.versionId })).status).toBe(404);
    expect((await issue(owner, { artifactId: "not-a-uuid", versionId: "x" })).status).toBe(404);
    expect((await issue({ cookie: "" }, site)).status).toBe(401);

    const crossSite = await previewTokenRoute(
      new Request(
        `${env.APP_ORIGIN}/api/artifacts/${site.artifactId}/versions/${site.versionId}/preview-token`,
        { method: "POST", headers: { origin: env.PREVIEW_ORIGIN, cookie: owner.cookie } },
      ),
      params({ id: site.artifactId, versionId: site.versionId }),
    );
    expect(crossSite.status).toBe(403);
  });
});
