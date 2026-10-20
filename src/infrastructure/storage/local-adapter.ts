import { createReadStream, createWriteStream } from "node:fs";
import { link, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { newId } from "@/lib/ids";
import { signToken, verifyToken, type SignedTokenClaims } from "@/lib/signed-token";
import { assertSafeStorageKey } from "./keys";
import {
  StorageObjectNotFoundError,
  type ListObjectsResult,
  type PutObjectOptions,
  type PutObjectResult,
  type SignedDownloadOptions,
  type SignedRequest,
  type SignedUploadOptions,
  type StorageAdapter,
  type StorageObjectInfo,
} from "./types";

/**
 * Filesystem storage for development, tests, and explicitly opted-in single-host deployments
 * (ADR-006). Layout under `rootDir`:
 *   objects/<key>          object bytes
 *   meta/<key>.json        { contentType, metadata, size }
 *   tmp/<uuid>             in-flight writes (atomically linked/renamed into place)
 *
 * Signed URLs point at app routes (`/api/storage/local/{upload,download}`) carrying an HMAC
 * token bound to the key, operation, expiry and (for uploads) the exact byte length.
 */

export const LOCAL_UPLOAD_PURPOSE = "local-storage:put";
export const LOCAL_DOWNLOAD_PURPOSE = "local-storage:get";

export interface LocalUploadClaims extends SignedTokenClaims {
  key: string;
  len: number;
  ct?: string;
}

export interface LocalDownloadClaims extends SignedTokenClaims {
  key: string;
  fn?: string;
  ct?: string;
}

interface MetaFile {
  contentType?: string;
  metadata?: Record<string, string>;
  size: number;
}

export class LocalStorageAdapter implements StorageAdapter {
  readonly provider = "local" as const;
  private readonly root: string;

  constructor(
    rootDir: string,
    private readonly options: { signingSecret: string; publicBaseUrl: string },
  ) {
    this.root = path.resolve(rootDir);
  }

  private resolveIn(area: "objects" | "meta", key: string, suffix = ""): string {
    assertSafeStorageKey(key);
    const base = path.join(this.root, area);
    const resolved = path.resolve(base, key + suffix);
    // Containment check: defense in depth on top of key validation.
    if (!resolved.startsWith(base + path.sep)) throw new Error("storage key escapes root");
    return resolved;
  }

  async putObject(
    key: string,
    body: Readable | Uint8Array,
    options: PutObjectOptions = {},
  ): Promise<PutObjectResult> {
    const target = this.resolveIn("objects", key);
    const metaPath = this.resolveIn("meta", key, ".json");
    const tmpDir = path.join(this.root, "tmp");
    await mkdir(tmpDir, { recursive: true });
    await mkdir(path.dirname(target), { recursive: true });
    await mkdir(path.dirname(metaPath), { recursive: true });

    if (options.ifNoneMatch && (await exists(target))) return { created: false };

    const tmp = path.join(tmpDir, newId());
    let size = 0;
    try {
      const source = body instanceof Uint8Array ? Readable.from([Buffer.from(body)]) : body;
      const counter = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          size += chunk.length;
          callback(null, chunk);
        },
      });
      await pipeline(source, counter, createWriteStream(tmp, { flags: "wx" }));
      if (options.contentLength !== undefined && options.contentLength !== size) {
        throw new Error(`content length mismatch: expected ${options.contentLength}, got ${size}`);
      }

      const meta: MetaFile = { contentType: options.contentType, metadata: options.metadata, size };
      if (options.ifNoneMatch) {
        try {
          // link() fails atomically with EEXIST if another writer won the race.
          await link(tmp, target);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "EEXIST") return { created: false };
          throw error;
        }
        await writeFile(metaPath, JSON.stringify(meta));
      } else {
        await writeFile(metaPath, JSON.stringify(meta));
        await rename(tmp, target);
      }
      return { created: true };
    } finally {
      await rm(tmp, { force: true });
    }
  }

  async getObject(key: string): Promise<{ body: Readable; info: StorageObjectInfo }> {
    const info = await this.headObject(key);
    if (!info) throw new StorageObjectNotFoundError(key);
    return { body: createReadStream(this.resolveIn("objects", key)), info };
  }

  async headObject(key: string): Promise<StorageObjectInfo | null> {
    const target = this.resolveIn("objects", key);
    let stats;
    try {
      stats = await stat(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    const meta = await this.readMeta(key);
    return {
      key,
      size: stats.size,
      contentType: meta?.contentType,
      metadata: meta?.metadata,
      lastModified: stats.mtime,
    };
  }

  async deleteObject(key: string): Promise<void> {
    await rm(this.resolveIn("objects", key), { force: true });
    await rm(this.resolveIn("meta", key, ".json"), { force: true });
  }

  async listObjects(
    prefix: string,
    options: { cursor?: string; limit?: number } = {},
  ): Promise<ListObjectsResult> {
    const limit = options.limit ?? 1000;
    const base = path.join(this.root, "objects");
    const all: string[] = [];
    await walk(base, "", all);
    const keys = all.filter((key) => key.startsWith(prefix)).sort();
    const start = options.cursor ? keys.findIndex((key) => key > options.cursor!) : 0;
    const page = start < 0 ? [] : keys.slice(start, start + limit);
    const items: StorageObjectInfo[] = [];
    for (const key of page) {
      const info = await this.headObject(key);
      if (info) items.push(info);
    }
    const nextCursor =
      start >= 0 && start + limit < keys.length ? page[page.length - 1] : undefined;
    return { items, nextCursor };
  }

  async createSignedUploadUrl(key: string, options: SignedUploadOptions): Promise<SignedRequest> {
    assertSafeStorageKey(key);
    const expiresAt = new Date(Date.now() + options.expiresInSeconds * 1000);
    const claims: LocalUploadClaims = {
      purpose: LOCAL_UPLOAD_PURPOSE,
      exp: Math.floor(expiresAt.getTime() / 1000),
      key,
      len: options.contentLength,
      ...(options.contentType ? { ct: options.contentType } : {}),
    };
    const token = signToken(this.options.signingSecret, claims);
    return {
      url: `${this.options.publicBaseUrl}/api/storage/local/upload?token=${encodeURIComponent(token)}`,
      method: "PUT",
      headers: options.contentType ? { "content-type": options.contentType } : {},
      expiresAt,
    };
  }

  async createSignedDownloadUrl(
    key: string,
    options: SignedDownloadOptions,
  ): Promise<SignedRequest> {
    assertSafeStorageKey(key);
    const expiresAt = new Date(Date.now() + options.expiresInSeconds * 1000);
    const claims: LocalDownloadClaims = {
      purpose: LOCAL_DOWNLOAD_PURPOSE,
      exp: Math.floor(expiresAt.getTime() / 1000),
      key,
      ...(options.filename ? { fn: options.filename } : {}),
      ...(options.contentType ? { ct: options.contentType } : {}),
    };
    const token = signToken(this.options.signingSecret, claims);
    return {
      url: `${this.options.publicBaseUrl}/api/storage/local/download?token=${encodeURIComponent(token)}`,
      method: "GET",
      headers: {},
      expiresAt,
    };
  }

  /** Verifies a token presented to the local upload route. */
  verifyUploadToken(token: string, now?: Date) {
    return verifyToken<LocalUploadClaims>(
      this.options.signingSecret,
      token,
      LOCAL_UPLOAD_PURPOSE,
      now,
    );
  }

  /** Verifies a token presented to the local download route. */
  verifyDownloadToken(token: string, now?: Date) {
    return verifyToken<LocalDownloadClaims>(
      this.options.signingSecret,
      token,
      LOCAL_DOWNLOAD_PURPOSE,
      now,
    );
  }

  private async readMeta(key: string): Promise<MetaFile | null> {
    try {
      return JSON.parse(await readFile(this.resolveIn("meta", key, ".json"), "utf8")) as MetaFile;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }
}

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function walk(base: string, relative: string, out: string[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(path.join(base, relative), { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  for (const entry of entries) {
    const child = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) await walk(base, child, out);
    else if (entry.isFile()) out.push(child);
  }
}
