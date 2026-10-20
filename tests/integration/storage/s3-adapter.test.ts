import { Readable } from "node:stream";
import { text } from "node:stream/consumers";
import { CreateBucketCommand, S3Client } from "@aws-sdk/client-s3";
import { beforeAll, describe, expect, it } from "vitest";
import { S3StorageAdapter, StorageObjectNotFoundError } from "@/infrastructure/storage";
import { newId } from "@/lib/ids";

/**
 * Runs against a real S3-compatible endpoint when S3_TEST_ENDPOINT is set
 * (CI uses a local `moto_server`; see .github/workflows/ci.yml). Never points at production.
 */
const endpoint = process.env.S3_TEST_ENDPOINT;
const config = {
  endpoint: endpoint ?? "http://127.0.0.1:0",
  region: "us-east-1",
  bucket: `vault-test-${newId().slice(-12)}`,
  accessKeyId: "test",
  secretAccessKey: "test",
  forcePathStyle: true,
};

describe.skipIf(!endpoint)("S3StorageAdapter (S3-compatible endpoint)", () => {
  const storage = new S3StorageAdapter(config);

  beforeAll(async () => {
    const client = new S3Client({
      endpoint: config.endpoint,
      region: config.region,
      forcePathStyle: true,
      credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
    });
    await client.send(new CreateBucketCommand({ Bucket: config.bucket }));
  });

  it("puts, heads, gets, lists and deletes", async () => {
    await storage.putObject("ws/a/one.txt", Buffer.from("hello"), {
      contentType: "text/plain",
      metadata: { sha256: "abc" },
    });
    await storage.putObject("ws/a/two.txt", Readable.from([Buffer.from("world")]), {
      contentLength: 5,
    });

    expect(await storage.headObject("ws/a/one.txt")).toMatchObject({
      size: 5,
      contentType: "text/plain",
      metadata: { sha256: "abc" },
    });
    expect(await text((await storage.getObject("ws/a/two.txt")).body)).toBe("world");
    expect((await storage.listObjects("ws/a/")).items.map((item) => item.key)).toEqual([
      "ws/a/one.txt",
      "ws/a/two.txt",
    ]);

    await storage.deleteObject("ws/a/one.txt");
    await storage.deleteObject("ws/a/one.txt");
    expect(await storage.headObject("ws/a/one.txt")).toBeNull();
    await expect(storage.getObject("ws/a/one.txt")).rejects.toBeInstanceOf(
      StorageObjectNotFoundError,
    );
  });

  it("requires contentLength for streams", async () => {
    await expect(storage.putObject("x", Readable.from([Buffer.from("a")]))).rejects.toThrow(
      /contentLength/,
    );
  });

  it("refuses to overwrite with ifNoneMatch (conditional write)", async () => {
    expect(
      await storage.putObject("imm/key", Buffer.from("original"), { ifNoneMatch: true }),
    ).toEqual({
      created: true,
    });
    expect(
      await storage.putObject("imm/key", Buffer.from("tampered"), { ifNoneMatch: true }),
    ).toEqual({
      created: false,
    });
    expect(await text((await storage.getObject("imm/key")).body)).toBe("original");
  });

  it("presigned PUT uploads the exact bytes; presigned GET downloads them", async () => {
    const body = Buffer.from("presigned-content-形態");
    const upload = await storage.createSignedUploadUrl("signed/obj", {
      contentLength: body.length,
      contentType: "text/plain",
      expiresInSeconds: 60,
    });
    const put = await fetch(upload.url, { method: "PUT", headers: upload.headers, body });
    expect(put.status).toBe(200);

    const download = await storage.createSignedDownloadUrl("signed/obj", {
      expiresInSeconds: 60,
      filename: "報告.txt",
    });
    const get = await fetch(download.url);
    expect(get.status).toBe(200);
    expect(Buffer.from(await get.arrayBuffer()).equals(body)).toBe(true);
    expect(get.headers.get("content-disposition")).toContain("attachment");
  });
});
