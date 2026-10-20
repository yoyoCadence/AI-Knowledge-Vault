import { getEnv } from "@/infrastructure/config/env";
import { LocalStorageAdapter } from "./local-adapter";
import { S3StorageAdapter } from "./s3-adapter";
import type { StorageAdapter } from "./types";

export * from "./types";
export { storageKeys, assertSafeStorageKey } from "./keys";
export { LocalStorageAdapter } from "./local-adapter";
export { S3StorageAdapter, contentDisposition } from "./s3-adapter";

let cached: StorageAdapter | undefined;

/** Process-wide storage adapter selected by STORAGE_DRIVER (ADR-006). */
export function getStorage(): StorageAdapter {
  if (cached) return cached;
  const env = getEnv();
  if (env.STORAGE_DRIVER === "s3") {
    cached = new S3StorageAdapter({
      endpoint: env.S3_ENDPOINT!,
      region: env.S3_REGION,
      bucket: env.S3_BUCKET!,
      accessKeyId: env.S3_ACCESS_KEY_ID!,
      secretAccessKey: env.S3_SECRET_ACCESS_KEY!,
      forcePathStyle: env.S3_FORCE_PATH_STYLE,
    });
  } else {
    cached = new LocalStorageAdapter(env.LOCAL_STORAGE_DIR, {
      signingSecret: env.LOCAL_STORAGE_SIGNING_SECRET!,
      publicBaseUrl: env.APP_ORIGIN,
    });
  }
  return cached;
}

/** Test hook: replace the process-wide adapter. */
export function setStorageForTesting(adapter: StorageAdapter | undefined): void {
  cached = adapter;
}
