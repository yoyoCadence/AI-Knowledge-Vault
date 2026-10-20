import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import type { Readable } from "node:stream";

/** SHA-256 (hex) of a stream, consumed fully. */
export async function sha256OfStream(stream: Readable): Promise<{ sha256: string; size: number }> {
  const hash = createHash("sha256");
  let size = 0;
  for await (const chunk of stream) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    hash.update(buffer);
  }
  return { sha256: hash.digest("hex"), size };
}

export function sha256OfFile(path: string): Promise<{ sha256: string; size: number }> {
  return sha256OfStream(createReadStream(path));
}

export function sha256OfBuffer(buffer: Uint8Array): string {
  return createHash("sha256").update(buffer).digest("hex");
}
