import { Readable } from "node:stream";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { assertSafeStorageKey } from "./keys";
import {
  StorageObjectNotFoundError,
  StorageUnavailableError,
  type ListObjectsResult,
  type PutObjectOptions,
  type PutObjectResult,
  type SignedDownloadOptions,
  type SignedRequest,
  type SignedUploadOptions,
  type StorageAdapter,
  type StorageObjectInfo,
} from "./types";

export interface S3AdapterConfig {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle?: boolean;
}

/**
 * S3-compatible adapter for Cloudflare R2 (or AWS S3, MinIO, Backblaze B2) (ADR-006).
 * Immutability uses conditional writes (`If-None-Match: *`), supported by R2 and S3.
 */
export class S3StorageAdapter implements StorageAdapter {
  readonly provider = "s3" as const;
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(config: S3AdapterConfig) {
    this.bucket = config.bucket;
    this.client = new S3Client({
      endpoint: config.endpoint,
      region: config.region,
      forcePathStyle: config.forcePathStyle ?? false,
      credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
      // Checksums on every request are not supported by all S3-compatible providers.
      requestChecksumCalculation: "WHEN_REQUIRED",
      responseChecksumValidation: "WHEN_REQUIRED",
    });
  }

  async putObject(
    key: string,
    body: Readable | Uint8Array,
    options: PutObjectOptions = {},
  ): Promise<PutObjectResult> {
    assertSafeStorageKey(key);
    if (body instanceof Readable && options.contentLength === undefined) {
      throw new Error("contentLength is required for streaming uploads");
    }
    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: body,
          ContentType: options.contentType,
          ContentLength: options.contentLength,
          Metadata: options.metadata,
          IfNoneMatch: options.ifNoneMatch ? "*" : undefined,
        }),
      );
      return { created: true };
    } catch (error) {
      if (options.ifNoneMatch && isStatus(error, 412)) return { created: false };
      throw wrap(error);
    }
  }

  async getObject(key: string): Promise<{ body: Readable; info: StorageObjectInfo }> {
    assertSafeStorageKey(key);
    try {
      const result = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      if (!(result.Body instanceof Readable))
        throw new StorageUnavailableError("unexpected response body type");
      return {
        body: result.Body,
        info: {
          key,
          size: Number(result.ContentLength ?? 0),
          contentType: result.ContentType,
          etag: result.ETag,
          lastModified: result.LastModified,
          metadata: result.Metadata,
        },
      };
    } catch (error) {
      if (isStatus(error, 404) || isName(error, "NoSuchKey"))
        throw new StorageObjectNotFoundError(key);
      throw wrap(error);
    }
  }

  async headObject(key: string): Promise<StorageObjectInfo | null> {
    assertSafeStorageKey(key);
    try {
      const result = await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      return {
        key,
        size: Number(result.ContentLength ?? 0),
        contentType: result.ContentType,
        etag: result.ETag,
        lastModified: result.LastModified,
        metadata: result.Metadata,
      };
    } catch (error) {
      if (isStatus(error, 404) || isName(error, "NotFound")) return null;
      throw wrap(error);
    }
  }

  async deleteObject(key: string): Promise<void> {
    assertSafeStorageKey(key);
    try {
      await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
    } catch (error) {
      if (isStatus(error, 404)) return;
      throw wrap(error);
    }
  }

  async listObjects(
    prefix: string,
    options: { cursor?: string; limit?: number } = {},
  ): Promise<ListObjectsResult> {
    try {
      const result = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: prefix,
          ContinuationToken: options.cursor,
          MaxKeys: options.limit ?? 1000,
        }),
      );
      return {
        items: (result.Contents ?? []).map((object) => ({
          key: object.Key ?? "",
          size: Number(object.Size ?? 0),
          etag: object.ETag,
          lastModified: object.LastModified,
        })),
        nextCursor: result.IsTruncated ? result.NextContinuationToken : undefined,
      };
    } catch (error) {
      throw wrap(error);
    }
  }

  async createSignedUploadUrl(key: string, options: SignedUploadOptions): Promise<SignedRequest> {
    assertSafeStorageKey(key);
    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      ContentLength: options.contentLength,
      ContentType: options.contentType,
    });
    // Signing content-length binds the URL to the declared size (SECURITY.md §4).
    const url = await getSignedUrl(this.client, command, {
      expiresIn: options.expiresInSeconds,
      signableHeaders: new Set([
        "content-length",
        ...(options.contentType ? ["content-type"] : []),
      ]),
    });
    return {
      url,
      method: "PUT",
      headers: options.contentType ? { "content-type": options.contentType } : {},
      expiresAt: new Date(Date.now() + options.expiresInSeconds * 1000),
    };
  }

  async createSignedDownloadUrl(
    key: string,
    options: SignedDownloadOptions,
  ): Promise<SignedRequest> {
    assertSafeStorageKey(key);
    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: key,
      ResponseContentDisposition: options.filename
        ? contentDisposition(options.filename)
        : "attachment",
      ResponseContentType: options.contentType,
    });
    const url = await getSignedUrl(this.client, command, { expiresIn: options.expiresInSeconds });
    return {
      url,
      method: "GET",
      headers: {},
      expiresAt: new Date(Date.now() + options.expiresInSeconds * 1000),
    };
  }
}

/** RFC 6266 attachment disposition with an ASCII fallback and UTF-8 filename*. */
export function contentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

function isStatus(error: unknown, status: number): boolean {
  return error instanceof S3ServiceException && error.$metadata?.httpStatusCode === status;
}

function isName(error: unknown, name: string): boolean {
  return error instanceof Error && error.name === name;
}

function wrap(error: unknown): Error {
  if (error instanceof StorageObjectNotFoundError || error instanceof StorageUnavailableError)
    return error;
  return new StorageUnavailableError("object storage request failed", { cause: error });
}
