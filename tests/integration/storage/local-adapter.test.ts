import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { text } from "node:stream/consumers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LocalStorageAdapter, StorageObjectNotFoundError } from "@/infrastructure/storage";

let dir: string;
let storage: LocalStorageAdapter;

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "vault-storage-"));
  storage = new LocalStorageAdapter(dir, {
    signingSecret: "s".repeat(48),
    publicBaseUrl: "http://localhost:3100",
  });
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("LocalStorageAdapter", () => {
  it("puts, heads, gets, lists and deletes objects", async () => {
    await storage.putObject("ws/a/one.txt", Buffer.from("hello"), {
      contentType: "text/plain",
      metadata: { sha256: "x" },
    });
    await storage.putObject(
      "ws/a/two.txt",
      Readable.from([Buffer.from("wor"), Buffer.from("ld")]),
      { contentLength: 5 },
    );
    await storage.putObject("ws/b/three.txt", Buffer.from("!"));

    const head = await storage.headObject("ws/a/one.txt");
    expect(head).toMatchObject({
      key: "ws/a/one.txt",
      size: 5,
      contentType: "text/plain",
      metadata: { sha256: "x" },
    });

    const { body } = await storage.getObject("ws/a/two.txt");
    expect(await text(body)).toBe("world");

    const listed = await storage.listObjects("ws/a/");
    expect(listed.items.map((item) => item.key)).toEqual(["ws/a/one.txt", "ws/a/two.txt"]);

    await storage.deleteObject("ws/a/one.txt");
    await storage.deleteObject("ws/a/one.txt"); // idempotent
    expect(await storage.headObject("ws/a/one.txt")).toBeNull();
    await expect(storage.getObject("ws/a/one.txt")).rejects.toBeInstanceOf(
      StorageObjectNotFoundError,
    );
  });

  it("paginates listings with a cursor", async () => {
    for (let index = 0; index < 5; index += 1) {
      await storage.putObject(`page/item-${index}`, Buffer.from(String(index)));
    }
    const first = await storage.listObjects("page/", { limit: 2 });
    expect(first.items.map((item) => item.key)).toEqual(["page/item-0", "page/item-1"]);
    const second = await storage.listObjects("page/", { limit: 2, cursor: first.nextCursor });
    expect(second.items.map((item) => item.key)).toEqual(["page/item-2", "page/item-3"]);
    const third = await storage.listObjects("page/", { limit: 2, cursor: second.nextCursor });
    expect(third.items.map((item) => item.key)).toEqual(["page/item-4"]);
    expect(third.nextCursor).toBeUndefined();
  });

  it("never overwrites when ifNoneMatch is set (immutability)", async () => {
    expect(
      await storage.putObject("imm/key", Buffer.from("original"), { ifNoneMatch: true }),
    ).toEqual({ created: true });
    expect(
      await storage.putObject("imm/key", Buffer.from("tampered"), { ifNoneMatch: true }),
    ).toEqual({ created: false });
    expect(await text((await storage.getObject("imm/key")).body)).toBe("original");
  });

  it("is safe under concurrent conditional writes", async () => {
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        storage.putObject("race/key", Buffer.from(`v${index}`), { ifNoneMatch: true }),
      ),
    );
    expect(results.filter((result) => result.created)).toHaveLength(1);
  });

  it("rejects content-length mismatches and leaves nothing behind", async () => {
    await expect(
      storage.putObject("len/key", Buffer.from("abc"), { contentLength: 4 }),
    ).rejects.toThrow(/mismatch/);
    expect(await storage.headObject("len/key")).toBeNull();
  });

  it("rejects unsafe keys", async () => {
    await expect(storage.putObject("../escape", Buffer.from("x"))).rejects.toThrow(/unsafe/);
    await expect(storage.headObject("a/../../etc/passwd")).rejects.toThrow(/unsafe/);
  });

  it("issues signed upload/download URLs bound to key, size, purpose and expiry", async () => {
    const upload = await storage.createSignedUploadUrl("signed/key", {
      contentLength: 10,
      expiresInSeconds: 60,
    });
    expect(upload.method).toBe("PUT");
    const token = new URL(upload.url).searchParams.get("token")!;
    const verified = storage.verifyUploadToken(token);
    expect(verified.ok && verified.claims).toMatchObject({ key: "signed/key", len: 10 });

    // An upload token is not a download token.
    expect(storage.verifyDownloadToken(token)).toEqual({ ok: false, reason: "wrong_purpose" });

    // Expired.
    const later = new Date(Date.now() + 120_000);
    expect(storage.verifyUploadToken(token, later)).toEqual({ ok: false, reason: "expired" });

    const download = await storage.createSignedDownloadUrl("signed/key", {
      expiresInSeconds: 60,
      filename: "報告.html",
    });
    const downloadToken = new URL(download.url).searchParams.get("token")!;
    const verifiedDownload = storage.verifyDownloadToken(downloadToken);
    expect(verifiedDownload.ok && verifiedDownload.claims).toMatchObject({
      key: "signed/key",
      fn: "報告.html",
    });
  });
});
