import { createReadStream } from "node:fs";
import type { StorageAdapter } from "@/infrastructure/storage";
import { storageKeys } from "@/infrastructure/storage";
import { AppError } from "@/lib/errors";

/**
 * Writes an original into immutable, content-addressed storage (ADR-006). Idempotent: if the
 * object already exists (retry, or the same bytes uploaded before) it is verified, never
 * overwritten. A size mismatch on an existing object means storage corruption and is surfaced.
 */
export async function storeOriginal(
  storage: StorageAdapter,
  input: {
    workspaceId: string;
    sha256: string;
    size: number;
    mimeType: string;
    sourcePath: string;
    /** Aborting destroys the upload's source stream, so the write fails instead of finishing. */
    signal?: AbortSignal;
  },
): Promise<{ storageKey: string; created: boolean }> {
  const storageKey = storageKeys.original(input.workspaceId, input.sha256);
  input.signal?.throwIfAborted();
  const body = createReadStream(input.sourcePath);
  // The adapter may await (mkdir, network) before attaching its own listeners: an abort in
  // that gap must reject putObject (it sees the stream's error state), never surface as an
  // uncaught 'error' event that would crash the worker.
  body.on("error", () => {});
  const onAbort = () => body.destroy(input.signal?.reason as Error);
  input.signal?.addEventListener("abort", onAbort, { once: true });
  let created: boolean;
  try {
    ({ created } = await storage.putObject(storageKey, body, {
      contentLength: input.size,
      contentType: input.mimeType,
      metadata: { sha256: input.sha256 },
      ifNoneMatch: true,
    }));
  } finally {
    input.signal?.removeEventListener("abort", onAbort);
  }
  input.signal?.throwIfAborted();
  if (!created) {
    const existing = await storage.headObject(storageKey);
    if (!existing)
      throw new AppError("STORAGE_UNAVAILABLE", "original vanished during write", {
        retryable: true,
      });
    const recordedHash = existing.metadata?.sha256;
    if (existing.size !== input.size || (recordedHash && recordedHash !== input.sha256)) {
      throw new AppError(
        "CHECKSUM_MISMATCH",
        "stored original does not match its content address",
        {
          details: { storageKey },
        },
      );
    }
  }
  return { storageKey, created };
}
