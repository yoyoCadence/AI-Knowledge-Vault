import { Readable } from "node:stream";
import { text } from "node:stream/consumers";
import { CreateBucketCommand, S3Client } from "@aws-sdk/client-s3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { S3StorageAdapter, StorageObjectNotFoundError } from "@/infrastructure/storage";
import { newId } from "@/lib/ids";

/**
 * Runs against a real S3-compatible endpoint when S3_TEST_ENDPOINT is set. Never production.
 *
 * - **An emulator** (CI: a local `moto_server`, .github/workflows/ci.yml): the suite creates a
 *   bucket of its own, with dummy credentials.
 * - **A real bucket, such as Cloudflare R2** (DEPLOYMENT.md §5.2): also set `S3_TEST_BUCKET`,
 *   `S3_TEST_REGION` (`auto` for R2) and `S3_TEST_ACCESS_KEY_ID` / `S3_TEST_SECRET_ACCESS_KEY`
 *   (a token scoped to that bucket). The suite writes only under a fresh
 *   `vault-adapter-test-<id>/` prefix and deletes everything it wrote. With
 *   `S3_TEST_CORS_ORIGIN` (the app's origin) it also checks the bucket's CORS rule.
 */
const endpoint = process.env.S3_TEST_ENDPOINT;
const existingBucket = process.env.S3_TEST_BUCKET;
const corsOrigin = process.env.S3_TEST_CORS_ORIGIN;
const config = {
  endpoint: endpoint ?? "http://127.0.0.1:0",
  region: process.env.S3_TEST_REGION ?? "us-east-1",
  bucket: existingBucket ?? `vault-test-${newId().slice(-12)}`,
  accessKeyId: process.env.S3_TEST_ACCESS_KEY_ID ?? "test",
  secretAccessKey: process.env.S3_TEST_SECRET_ACCESS_KEY ?? "test",
  forcePathStyle: true,
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
