import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { StorageAdapter } from "@/infrastructure/storage";
import { AppError } from "@/lib/errors";

/**
 * Downloads an uploaded object to a private temp file while computing its SHA-256 and size and
 * capturing the first bytes for format sniffing. Enforces the byte limit while streaming, so an
 * oversized object can never fill the disk or memory (SECURITY.md §4).
 */
export interface StagedFile {
  dir: string;
  path: string;
  size: number;
  sha256: string;
  head: Buffer;
  cleanup(): Promise<void>;
}

const HEAD_BYTES = 8192;

export async function downloadToTempFile(
  storage: StorageAdapter,
  key: string,
  options: { maxBytes: number; signal?: AbortSignal },
): Promise<StagedFile> {
  const dir = await mkdtemp(path.join(tmpdir(), "vault-import-"));
  const file = path.join(dir, "object");
  const cleanup = () => rm(dir, { recursive: true, force: true });
  try {
    const { body } = await storage.getObject(key);
    const hash = createHash("sha256");
    const headChunks: Buffer[] = [];
    let headLength = 0;
    let size = 0;
    const meter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        size += chunk.length;
        if (size > options.maxBytes) {
          callback(
            new AppError(
              "PAYLOAD_TOO_LARGE",
              `file exceeds the limit of ${options.maxBytes} bytes`,
            ),
          );
          return;
        }
        hash.update(chunk);
        if (headLength < HEAD_BYTES) {
          headChunks.push(chunk.subarray(0, HEAD_BYTES - headLength));
          headLength += Math.min(chunk.length, HEAD_BYTES - headLength);
        }
        callback(null, chunk);
      },
    });
    await pipeline(body, meter, createWriteStream(file, { flags: "wx", mode: 0o600 }), {
      signal: options.signal,
    });
    return {
      dir,
      path: file,
      size,
      sha256: hash.digest("hex"),
      head: Buffer.concat(headChunks),
      cleanup,
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
