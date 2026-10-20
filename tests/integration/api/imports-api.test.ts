import { createHash } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { GET as getArtifact } from "@/app/api/artifacts/[id]/route";
import { GET as getOriginal } from "@/app/api/artifacts/[id]/versions/[versionId]/original/route";
import { GET as listArtifactsRoute } from "@/app/api/artifacts/route";
import { POST as completeRoute } from "@/app/api/imports/[batchId]/items/[itemId]/complete/route";
import { POST as declareRoute } from "@/app/api/imports/[batchId]/items/route";
import { GET as batchReportRoute } from "@/app/api/imports/[batchId]/route";
import { POST as createBatchRoute, GET as listBatchesRoute } from "@/app/api/imports/route";
import { GET as localDownload } from "@/app/api/storage/local/download/route";
import { PUT as localUpload } from "@/app/api/storage/local/upload/route";
import { getEnv } from "@/infrastructure/config/env";
import { closeDb } from "@/infrastructure/database/client";
import { htmlDocument } from "@tests/fixtures/builders";
import { createTestAdmin, signIn } from "../helpers/auth";
import { closeTestDb } from "../helpers/db";
import { drainJobs } from "../helpers/imports";

afterAll(async () => {
  await closeDb();
  await closeTestDb();
});

const origin = () => getEnv().APP_ORIGIN;
const params = <T>(value: T) => ({ params: Promise.resolve(value) });

function apiRequest(path: string, init: { method?: string; cookie?: string; body?: unknown } = {}) {
  const headers = new Headers({ origin: origin(), "content-type": "application/json" });
  if (init.cookie) headers.set("cookie", init.cookie);
  return new Request(`${origin()}${path}`, {
    method: init.method ?? "GET",
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}

async function loggedIn() {
  const admin = await createTestAdmin();
  const { cookie } = await signIn(admin.email, admin.password);
  return { ...admin, cookie };
}

describe("import API over HTTP handlers", () => {
  it("paginates GET /api/imports with limit and an opaque cursor", async () => {
    const { cookie } = await loggedIn();
    const created: string[] = [];
    for (let n = 0; n < 3; n += 1) {
      const response = await createBatchRoute(
        apiRequest("/api/imports", { method: "POST", cookie, body: {} }),
        params({}),
      );
      created.push(((await response.json()) as { batch: { id: string } }).batch.id);
    }
    type Page = { items: { id: string }[]; nextCursor: string | null };
    const first = (await (
      await listBatchesRoute(apiRequest("/api/imports?limit=2", { cookie }), params({}))
    ).json()) as Page;
    expect(first.items.map((batch) => batch.id)).toEqual([created[2], created[1]]);
    expect(first.nextCursor).toBeTruthy();

    const second = (await (
      await listBatchesRoute(
        apiRequest(`/api/imports?limit=2&cursor=${first.nextCursor}`, { cookie }),
        params({}),
      )
    ).json()) as Page;
    expect(second.items.map((batch) => batch.id)).toEqual([created[0]]);
    expect(second.nextCursor).toBeNull();

    const invalid = await listBatchesRoute(
      apiRequest("/api/imports?cursor=bm90LWEtY3Vyc29y", { cookie }),
      params({}),
    );
    expect(invalid.status).toBe(400);
  });

  it("runs the full browser flow: batch → declare → PUT upload → complete → report → download", async () => {
    const { cookie } = await loggedIn();
    const html = Buffer.from(htmlDocument({ title: "HTTP 流程測試" }));

    const created = await createBatchRoute(
      apiRequest("/api/imports", { method: "POST", cookie, body: {} }),
      params({}),
    );
    expect(created.status).toBe(201);
    const { batch } = (await created.json()) as { batch: { id: string } };

    const declared = await declareRoute(
      apiRequest(`/api/imports/${batch.id}/items`, {
        method: "POST",
        cookie,
        body: { filename: "http-flow.html", size: html.length },
      }),
      params({ batchId: batch.id }),
    );
    expect(declared.status).toBe(201);
    const { item, upload } = (await declared.json()) as {
      item: { id: string; status: string };
      upload: { url: string; method: string; headers: Record<string, string> };
    };
    expect(item.status).toBe("awaiting_upload");
    expect(JSON.stringify(item)).not.toContain("staging");

    // Upload through the token-authorized local storage route (what the browser does).
    const put = await localUpload(
      new Request(upload.url, {
        method: "PUT",
        body: html,
        headers: { "content-length": String(html.length) },
      }),
    );
    expect(put.status).toBe(200);

    const completed = await completeRoute(
      apiRequest(`/api/imports/${batch.id}/items/${item.id}/complete`, {
        method: "POST",
        cookie,
        body: {},
      }),
      params({ batchId: batch.id, itemId: item.id }),
    );
    expect(completed.status).toBe(202);

    await drainJobs();
    const report = await batchReportRoute(
      apiRequest(`/api/imports/${batch.id}`, { cookie }),
      params({ batchId: batch.id }),
    );
    const body = (await report.json()) as {
      counts: { succeeded: number };
      items: { resultArtifactId: string; resultVersionId: string }[];
    };
    expect(body.counts.succeeded).toBe(1);
    const { resultArtifactId, resultVersionId } = body.items[0]!;

    const listing = (await (
      await listArtifactsRoute(apiRequest("/api/artifacts", { cookie }), params({}))
    ).json()) as { items: { id: string }[] };
    expect(listing.items.map((card) => card.id)).toContain(resultArtifactId);
    const detail = await getArtifact(
      apiRequest(`/api/artifacts/${resultArtifactId}`, { cookie }),
      params({ id: resultArtifactId }),
    );
    expect(((await detail.json()) as { artifact: { title: string } }).artifact.title).toBe(
      "HTTP 流程測試",
    );

    const redirect = await getOriginal(
      apiRequest(`/api/artifacts/${resultArtifactId}/versions/${resultVersionId}/original`, {
        cookie,
      }),
      params({ id: resultArtifactId, versionId: resultVersionId }),
    );
    expect(redirect.status).toBe(302);
    const location = redirect.headers.get("location")!;
    const file = await localDownload(new Request(location));
    expect(file.status).toBe(200);
    expect(file.headers.get("content-disposition")).toMatch(/^attachment/);
    const bytes = Buffer.from(await file.arrayBuffer());
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(
      redirect.headers.get("x-content-sha256"),
    );
  });

  it("enforces upload token binding: wrong size, tampered or expired tokens are refused", async () => {
    const { cookie } = await loggedIn();
    const { batch } = (await (
      await createBatchRoute(
        apiRequest("/api/imports", { method: "POST", cookie, body: {} }),
        params({}),
      )
    ).json()) as {
      batch: { id: string };
    };
    const { upload } = (await (
      await declareRoute(
        apiRequest(`/api/imports/${batch.id}/items`, {
          method: "POST",
          cookie,
          body: { filename: "bound.txt", size: 5 },
        }),
        params({ batchId: batch.id }),
      )
    ).json()) as { upload: { url: string } };

    const tooBig = await localUpload(
      new Request(upload.url, { method: "PUT", body: Buffer.from("way more than five bytes") }),
    );
    expect(tooBig.status).toBeGreaterThanOrEqual(400);
    const tampered = await localUpload(
      new Request(`${upload.url}x`, { method: "PUT", body: Buffer.from("hello") }),
    );
    expect(tampered.status).toBe(403);
    const ok = await localUpload(
      new Request(upload.url, { method: "PUT", body: Buffer.from("hello") }),
    );
    expect(ok.status).toBe(200);
  });

  it("validates declarations and hides other workspaces' batches", async () => {
    const owner = await loggedIn();
    const stranger = await loggedIn();
    const { batch } = (await (
      await createBatchRoute(
        apiRequest("/api/imports", { method: "POST", cookie: owner.cookie, body: {} }),
        params({}),
      )
    ).json()) as {
      batch: { id: string };
    };

    const badType = await declareRoute(
      apiRequest(`/api/imports/${batch.id}/items`, {
        method: "POST",
        cookie: owner.cookie,
        body: { filename: "malware.exe", size: 10 },
      }),
      params({ batchId: batch.id }),
    );
    expect(badType.status).toBe(422);
    const badBody = await declareRoute(
      apiRequest(`/api/imports/${batch.id}/items`, {
        method: "POST",
        cookie: owner.cookie,
        body: { filename: "", size: -1 },
      }),
      params({ batchId: batch.id }),
    );
    expect(badBody.status).toBe(400);

    const foreign = await batchReportRoute(
      apiRequest(`/api/imports/${batch.id}`, { cookie: stranger.cookie }),
      params({ batchId: batch.id }),
    );
    expect(foreign.status).toBe(404);
    const anonymous = await batchReportRoute(
      apiRequest(`/api/imports/${batch.id}`),
      params({ batchId: batch.id }),
    );
    expect(anonymous.status).toBe(401);
  });
});
