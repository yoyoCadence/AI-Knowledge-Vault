import type { Readable } from "node:stream";

/**
 * Provider-neutral object storage contract (ADR-006).
 * Business logic depends only on this interface — never on a cloud SDK.
 */
export type StorageProvider = "local" | "s3";

export interface StorageObjectInfo {
  key: string;
  size: number;
  contentType?: string | undefined;
  etag?: string | undefined;
  lastModified?: Date | undefined;
  metadata?: Record<string, string> | undefined;
}

export interface PutObjectOptions {
  contentType?: string;
  /** Required when `body` is a stream (S3 single-part PUT needs Content-Length). */
  contentLength?: number;
  /** User metadata (ASCII keys/values only). */
  metadata?: Record<string, string>;
  /** Write only if no object exists at `key` (immutability, ADR-006). */
  ifNoneMatch?: boolean;
}

export interface PutObjectResult {
  /** `false` when `ifNoneMatch` was set and an object already existed (nothing written). */
  created: boolean;
}

export interface SignedRequest {
  url: string;
  method: "PUT" | "GET";
  /** Headers the client must send verbatim. */
  headers: Record<string, string>;
  expiresAt: Date;
}

export interface SignedUploadOptions {
  contentLength: number;
  contentType?: string;
  expiresInSeconds: number;
}

export interface SignedDownloadOptions {
  expiresInSeconds: number;
  /** Suggested download filename (sent as Content-Disposition: attachment). */
  filename?: string;
  contentType?: string;
}

export interface ListObjectsResult {
  items: StorageObjectInfo[];
  nextCursor?: string | undefined;
}

export interface StorageAdapter {
  readonly provider: StorageProvider;
  putObject(
    key: string,
    body: Readable | Uint8Array,
    options?: PutObjectOptions,
  ): Promise<PutObjectResult>;
  /** Throws `StorageObjectNotFoundError` when missing. */
  getObject(key: string): Promise<{ body: Readable; info: StorageObjectInfo }>;
  /** Returns `null` when missing. */
  headObject(key: string): Promise<StorageObjectInfo | null>;
  /** Idempotent: deleting a missing object succeeds. */
  deleteObject(key: string): Promise<void>;
  listObjects(
    prefix: string,
    options?: { cursor?: string; limit?: number },
  ): Promise<ListObjectsResult>;
  createSignedUploadUrl(key: string, options: SignedUploadOptions): Promise<SignedRequest>;
  createSignedDownloadUrl(key: string, options: SignedDownloadOptions): Promise<SignedRequest>;
}

export class StorageObjectNotFoundError extends Error {
  constructor(public readonly key: string) {
    super("Storage object not found");
    this.name = "StorageObjectNotFoundError";
  }
}

export class StorageUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "StorageUnavailableError";
  }
}
