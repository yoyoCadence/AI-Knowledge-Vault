import { isUuid } from "@/lib/ids";

/**
 * The only place storage keys are constructed (docs/SECURITY.md §11).
 * Inputs are validated so a key can never contain traversal segments or attacker-chosen paths.
 * Keys are NOT a security boundary: every access is authorized before a key is used.
 */

const SHA256_HEX = /^[a-f0-9]{64}$/;

function uuid(value: string, label: string): string {
  if (!isUuid(value)) throw new Error(`invalid ${label} for storage key`);
  return value.toLowerCase();
}

function sha256(value: string): string {
  if (!SHA256_HEX.test(value)) throw new Error("invalid sha256 for storage key");
  return value;
}

export const storageKeys = {
  workspacePrefix: (workspaceId: string) => `ws/${uuid(workspaceId, "workspaceId")}/`,
  /** Immutable, content-addressed original (ADR-006). */
  original: (workspaceId: string, contentSha256: string) =>
    `ws/${uuid(workspaceId, "workspaceId")}/originals/${sha256(contentSha256)}`,
  staging: (workspaceId: string, importItemId: string) =>
    `ws/${uuid(workspaceId, "workspaceId")}/staging/${uuid(importItemId, "importItemId")}`,
  stagingPrefix: (workspaceId: string) => `ws/${uuid(workspaceId, "workspaceId")}/staging/`,
  derivedPrefix: (workspaceId: string, versionId: string) =>
    `ws/${uuid(workspaceId, "workspaceId")}/derived/${uuid(versionId, "versionId")}/`,
  /** Derived (regenerable) file. The display path lives in the DB, never in the key. */
  derived: (workspaceId: string, versionId: string, derivedAssetId: string) =>
    `ws/${uuid(workspaceId, "workspaceId")}/derived/${uuid(versionId, "versionId")}/${uuid(derivedAssetId, "derivedAssetId")}`,
  export: (workspaceId: string, exportId: string) =>
    `ws/${uuid(workspaceId, "workspaceId")}/exports/${uuid(exportId, "exportId")}.zip`,
  restoreUpload: (workspaceId: string, restoreId: string) =>
    `ws/${uuid(workspaceId, "workspaceId")}/restores/${uuid(restoreId, "restoreId")}.zip`,
} as const;

/** Generic key sanity check used by adapters as a second line of defense. */
export function assertSafeStorageKey(key: string): void {
  if (
    key.length === 0 ||
    Buffer.byteLength(key, "utf8") > 1024 ||
    key.startsWith("/") ||
    key.includes("\\") ||
    key.includes("//") ||
    /[\u0000-\u001f\u007f]/.test(key) ||
    key.split("/").some((segment) => segment === "." || segment === "..")
  ) {
    throw new Error("unsafe storage key");
  }
}
