import { Readable } from "node:stream";
import { text } from "node:stream/consumers";
import { CreateBucketCommand, S3Client } from "@aws-sdk/client-s3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { S3StorageAdapter, StorageObjectNotFoundError } from "@/infrastructure/storage";
import { newId } from "@/lib/ids";

/**
 * Runs against a real S3-compatible endpoint when S3_TEST_ENDPOINT is set. Never production
 * data: every key is under a fresh prefix, removed afterwards.
 *
 * - **An emulator** (CI: a local `moto_server`, .github/workflows/ci.yml): the suite creates a
 *   bucket of its own, with dummy credentials. Only on a local endpoint: elsewhere that would
 *   create a bucket in someone's account.
 * - **A real bucket, such as Cloudflare R2**: `pnpm storage:verify` (DEPLOYMENT.md §5.2, step
 *   5), with `S3_TEST_BUCKET`, `S3_TEST_REGION` (`auto` for R2), `S3_TEST_ACCESS_KEY_ID` /
 *   `S3_TEST_SECRET_ACCESS_KEY` (a token scoped to that bucket) and `S3_TEST_CORS_ORIGIN` (the
 *   origin the bucket's CORS rule allows). It uses the app's URL style (virtual-hosted) unless
 *   `S3_TEST_FORCE_PATH_STYLE=true`. Against a real provider it also checks that presigned
 *   uploads are bound to their size and type, which an emulator does not enforce.
 */
const env = process.env;
const endpoint = env.S3_TEST_ENDPOINT || undefined;
const existingBucket = env.S3_TEST_BUCKET || undefined;
const corsOrigin = env.S3_TEST_CORS_ORIGIN || undefined;

if (env.S3_TEST_VERIFY === "1") {
  const missing = [
    "S3_TEST_ENDPOINT",
    "S3_TEST_BUCKET",
    "S3_TEST_REGION",
    "S3_TEST_ACCESS_KEY_ID",
    "S3_TEST_SECRET_ACCESS_KEY",
    "S3_TEST_CORS_ORIGIN",
  ].filter((name) => !env[name]);
  if (missing.length > 0) {
    throw new Error(
      `storage:verify needs ${missing.join(", ")} (DEPLOYMENT.md §5.2, step 5); nothing was checked`,
    );
  }
}
const localEndpoint =
  endpoint !== undefined &&
  ["127.0.0.1", "localhost", "[::1]"].includes(new URL(endpoint).hostname);
if (endpoint && !existingBucket && !localEndpoint) {
  throw new Error(
    "S3_TEST_BUCKET is required for a non-local endpoint: the suite creates buckets only on a local emulator",
  );
}

const config = {
  endpoint: endpoint ?? "http://127.0.0.1:0",
  region: env.S3_TEST_REGION || "us-east-1",
  bucket: existingBucket ?? `vault-test-${newId().slice(-12)}`,
  accessKeyId: env.S3_TEST_ACCESS_KEY_ID || "test",
  secretAccessKey: env.S3_TEST_SECRET_ACCESS_KEY || "test",
  // The emulator answers path-style only; a real bucket is checked as the app reaches it.
  forcePathStyle: env.S3_TEST_FORCE_PATH_STYLE
    ? env.S3_TEST_FORCE_PATH_STYLE === "true"
    : !existingBucket,
};
/** Every key this run touches: a bucket shared with anything else is left as it was. */
const prefix = `vault-adapter-test-${newId()}/`;
const key = (name: string) => `${prefix}${name}`;

describe.skipIf(!endpoint)("S3StorageAdapter (S3-compatible endpoint)", () => {
  const storage = new S3StorageAdapter(config);

  beforeAll(async () => {
    if (existingBucket) return;
    const client = new S3Client({
      endpoint: config.endpoint,
      region: config.region,
      forcePathStyle: true,
      credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
    });
    await client.send(new CreateBucketCommand({ Bucket: config.bucket }));
  });

  afterAll(async () => {
    let cursor: string | undefined;
    do {
      const page = await storage.listObjects(prefix, { cursor });
      for (const item of page.items) await storage.deleteObject(item.key);
      cursor = page.nextCursor;
    } while (cursor);
    expect((await storage.listObjects(prefix)).items).toEqual([]);
  });

  it("puts, heads, gets, lists and deletes", async () => {
    await storage.putObject(key("ws/a/one.txt"), Buffer.from("hello"), {
      contentType: "text/plain",
      metadata: { sha256: "abc" },
    });
    await storage.putObject(key("ws/a/two.txt"), Readable.from([Buffer.from("world")]), {
      contentLength: 5,
    });

    expect(await storage.headObject(key("ws/a/one.txt"))).toMatchObject({
      size: 5,
      contentType: "text/plain",
      metadata: { sha256: "abc" },
    });
    expect(await text((await storage.getObject(key("ws/a/two.txt"))).body)).toBe("world");
    expect((await storage.listObjects(key("ws/a/"))).items.map((item) => item.key)).toEqual([
      key("ws/a/one.txt"),
      key("ws/a/two.txt"),
    ]);

    await storage.deleteObject(key("ws/a/one.txt"));
    await storage.deleteObject(key("ws/a/one.txt"));
    expect(await storage.headObject(key("ws/a/one.txt"))).toBeNull();
    await expect(storage.getObject(key("ws/a/one.txt"))).rejects.toBeInstanceOf(
      StorageObjectNotFoundError,
    );
  });

  it("lists page by page with a cursor", async () => {
    for (const name of ["p/1", "p/2", "p/3"]) {
      await storage.putObject(key(name), Buffer.from(name));
    }
    const first = await storage.listObjects(key("p/"), { limit: 2 });
    expect(first.items.map((item) => item.key)).toEqual([key("p/1"), key("p/2")]);
    expect(first.nextCursor).toBeTruthy();
    const second = await storage.listObjects(key("p/"), { cursor: first.nextCursor, limit: 2 });
    expect(second.items.map((item) => item.key)).toEqual([key("p/3")]);
    expect(second.nextCursor).toBeUndefined();
  });

  it("requires contentLength for streams", async () => {
    await expect(storage.putObject(key("x"), Readable.from([Buffer.from("a")]))).rejects.toThrow(
      /contentLength/,
    );
  });

  it("refuses to overwrite with ifNoneMatch (conditional write)", async () => {
    // Originals are immutable (SECURITY.md): the provider must honour If-None-Match.
    expect(
      await storage.putObject(key("imm/key"), Buffer.from("original"), { ifNoneMatch: true }),
    ).toEqual({ created: true });
    expect(
      await storage.putObject(key("imm/key"), Buffer.from("tampered"), { ifNoneMatch: true }),
    ).toEqual({ created: false });
    expect(await text((await storage.getObject(key("imm/key"))).body)).toBe("original");
  });

  it("presigned PUT uploads the exact bytes; presigned GET downloads them", async () => {
    const body = Buffer.from("presigned-content-形態");
    const upload = await storage.createSignedUploadUrl(key("signed/obj"), {
      contentLength: body.length,
      contentType: "text/plain",
      expiresInSeconds: 60,
    });
    const put = await fetch(upload.url, { method: "PUT", headers: upload.headers, body });
    expect(put.status).toBe(200);

    const download = await storage.createSignedDownloadUrl(key("signed/obj"), {
      expiresInSeconds: 60,
      filename: "報告.txt",
    });
    const get = await fetch(download.url);
    expect(get.status).toBe(200);
    expect(Buffer.from(await get.arrayBuffer()).equals(body)).toBe(true);
    expect(get.headers.get("content-disposition")).toContain("attachment");
  });

  it.skipIf(localEndpoint)("binds a presigned upload to its size and type", async () => {
    const body = Buffer.from("twelve bytes");
    const upload = await storage.createSignedUploadUrl(key("bound/obj"), {
      contentLength: body.length,
      contentType: "text/plain",
      expiresInSeconds: 60,
    });
    // fetch sends the body's own length, so the provider sees a length other than the signed one.
    const longer = await fetch(upload.url, {
      method: "PUT",
      headers: upload.headers,
      body: Buffer.concat([body, Buffer.from("+more")]),
    });
    expect(longer.ok).toBe(false);
    const otherType = await fetch(upload.url, {
      method: "PUT",
      headers: { "content-type": "text/html" },
      body,
    });
    expect(otherType.ok).toBe(false);
    expect(await storage.headObject(key("bound/obj"))).toBeNull();
    const exact = await fetch(upload.url, { method: "PUT", headers: upload.headers, body });
    expect(exact.status).toBe(200);
  });

  it.skipIf(!corsOrigin)("lets the app's origin upload (CORS), and no other origin", async () => {
    const upload = await storage.createSignedUploadUrl(key("cors/obj"), {
      contentLength: 1,
      contentType: "text/plain",
      expiresInSeconds: 60,
    });
    const preflight = (origin: string) =>
      fetch(upload.url, {
        method: "OPTIONS",
        headers: {
          origin,
          "access-control-request-method": "PUT",
          "access-control-request-headers": "content-type",
        },
      });
    const app = await preflight(corsOrigin!);
    expect(app.ok).toBe(true);
    expect(app.headers.get("access-control-allow-origin")).toBe(corsOrigin);
    expect(app.headers.get("access-control-allow-methods") ?? "").toMatch(/\bPUT\b/i);
    expect(app.headers.get("access-control-allow-headers") ?? "").toMatch(/content-type/i);
    // A browser passes a preflight only on a 2xx answer that allows the origin.
    const elsewhere = await preflight("https://elsewhere.example");
    const allowed =
      elsewhere.ok &&
      ["*", "https://elsewhere.example"].includes(
        elsewhere.headers.get("access-control-allow-origin") ?? "",
      );
    expect(allowed).toBe(false);
  });
});
