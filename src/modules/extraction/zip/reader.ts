import { Transform, type Readable } from "node:stream";
import yauzl, { type Entry, type ZipFile } from "yauzl";
import { AppError } from "@/lib/errors";

/**
 * Safe ZIP reading (docs/IMPORT_PIPELINE.md §4, NFR-SEC-5).
 *
 * Defense layers:
 * - yauzl rejects absolute paths, drive letters, `..` segments and backslashes, and verifies each
 *   entry's actual decompressed size against its header (`validateEntrySizes`).
 * - We additionally reject symlinks, encrypted entries, NUL/control characters, over-deep or
 *   over-long paths, too many entries, suspicious compression ratios, and oversize totals — and
 *   count *actual* decompressed bytes while streaming, never trusting headers alone.
 * - Entry names are only ever used as keys/labels; nothing is written to a filesystem path.
 */

export interface ZipLimits {
  maxEntries: number;
  maxTotalUncompressedBytes: number;
  maxEntryBytes: number;
  maxCompressionRatio: number;
  maxPathDepth: number;
}

export interface ZipEntryInfo {
  /** Normalized, validated relative path (forward slashes, NFC, no leading "./"). */
  path: string;
  size: number;
  compressedSize: number;
  isDirectory: boolean;
}

export interface ZipInventory {
  entries: ZipEntryInfo[];
  totalUncompressed: number;
  nestedArchives: string[];
  warnings: string[];
}

export type ZipRejectionCode =
  | "ZIP_INVALID"
  | "ZIP_ENTRY_PATH_TRAVERSAL"
  | "ZIP_ENTRY_ABSOLUTE_PATH"
  | "ZIP_ENTRY_INVALID_NAME"
  | "ZIP_ENTRY_SYMLINK"
  | "ZIP_ENTRY_ENCRYPTED"
  | "ZIP_PATH_TOO_DEEP"
  | "ZIP_TOO_MANY_ENTRIES"
  | "ZIP_TOO_LARGE"
  | "ZIP_ENTRY_TOO_LARGE"
  | "ZIP_COMPRESSION_RATIO"
  | "ZIP_SIZE_MISMATCH";

export class ZipRejectedError extends AppError {
  constructor(
    readonly reason: ZipRejectionCode,
    detail: string,
  ) {
    super("ARCHIVE_REJECTED", `${reason}: ${detail.slice(0, 300)}`, { details: { reason } });
    this.name = "ZipRejectedError";
  }
}

const NESTED_ARCHIVE = /\.(zip|jar|war|tar|tgz|gz|bz2|xz|7z|rar)$/i;
const ONE_MIB = 1024 * 1024;

function mapYauzlError(error: Error): ZipRejectedError {
  const message = error.message;
  if (/invalid relative path/i.test(message))
    return new ZipRejectedError("ZIP_ENTRY_PATH_TRAVERSAL", message);
  if (/absolute path/i.test(message))
    return new ZipRejectedError("ZIP_ENTRY_ABSOLUTE_PATH", message);
  if (/invalid characters in fileName/i.test(message))
    return new ZipRejectedError("ZIP_ENTRY_INVALID_NAME", message);
  if (/encrypt/i.test(message)) return new ZipRejectedError("ZIP_ENTRY_ENCRYPTED", message);
  if (/too many|too few|uncompressed size|expected/i.test(message))
    return new ZipRejectedError("ZIP_SIZE_MISMATCH", message);
  return new ZipRejectedError("ZIP_INVALID", message);
}

function validateEntry(entry: Entry, limits: ZipLimits): ZipEntryInfo {
  const raw = entry.fileName;
  if (/[\u0000-\u001f\u007f]/.test(raw))
    throw new ZipRejectedError("ZIP_ENTRY_INVALID_NAME", JSON.stringify(raw));
  const isDirectory = raw.endsWith("/");
  const path = raw
    .normalize("NFC")
    .replace(/^(\.\/)+/, "")
    .replace(/\/+$/, "");
  const segments = path.split("/");
  if (segments.some((segment) => segment === ".." || segment === ".")) {
    throw new ZipRejectedError("ZIP_ENTRY_PATH_TRAVERSAL", raw);
  }
  if (segments.length > limits.maxPathDepth || Buffer.byteLength(path) > 512) {
    throw new ZipRejectedError("ZIP_PATH_TOO_DEEP", raw);
  }
  const mode = (entry.externalFileAttributes >>> 16) & 0o170000;
  if (mode === 0o120000) throw new ZipRejectedError("ZIP_ENTRY_SYMLINK", raw);
  if (entry.isEncrypted()) throw new ZipRejectedError("ZIP_ENTRY_ENCRYPTED", raw);
  if (entry.uncompressedSize > limits.maxEntryBytes) {
    throw new ZipRejectedError("ZIP_ENTRY_TOO_LARGE", `${raw} (${entry.uncompressedSize} bytes)`);
  }
  if (
    entry.uncompressedSize > ONE_MIB &&
    entry.uncompressedSize / Math.max(1, entry.compressedSize) > limits.maxCompressionRatio
  ) {
    throw new ZipRejectedError(
      "ZIP_COMPRESSION_RATIO",
      `${raw} expands ${Math.round(entry.uncompressedSize / Math.max(1, entry.compressedSize))}×`,
    );
  }
  return { path, size: entry.uncompressedSize, compressedSize: entry.compressedSize, isDirectory };
}

/** An open archive with a validated inventory; entries are streamed on demand. */
export class SafeZip {
  private constructor(
    private readonly zip: ZipFile,
    private readonly byPath: Map<string, Entry>,
    readonly inventory: ZipInventory,
    private readonly limits: ZipLimits,
  ) {}

  /** Opens and fully validates the archive's central directory. Throws ZipRejectedError. */
  static async open(filePath: string, limits: ZipLimits): Promise<SafeZip> {
    let zip: ZipFile;
    try {
      zip = await new Promise<ZipFile>((resolve, reject) =>
        yauzl.open(
          filePath,
          {
            lazyEntries: true,
            autoClose: false,
            decodeStrings: true,
            validateEntrySizes: true,
            strictFileNames: false,
          },
          (error, zipfile) =>
            error || !zipfile ? reject(error ?? new Error("cannot open zip")) : resolve(zipfile),
        ),
      );
    } catch (error) {
      throw mapYauzlError(error as Error);
    }

    const byPath = new Map<string, Entry>();
    const lowerSeen = new Set<string>();
    const inventory: ZipInventory = {
      entries: [],
      totalUncompressed: 0,
      nestedArchives: [],
      warnings: [],
    };
    try {
      await new Promise<void>((resolve, reject) => {
        zip.on("error", (error: Error) =>
          reject(error instanceof ZipRejectedError ? error : mapYauzlError(error)),
        );
        zip.on("end", () => resolve());
        zip.on("entry", (entry: Entry) => {
          try {
            if (inventory.entries.length >= limits.maxEntries) {
              throw new ZipRejectedError(
                "ZIP_TOO_MANY_ENTRIES",
                `more than ${limits.maxEntries} entries`,
              );
            }
            const info = validateEntry(entry, limits);
            inventory.totalUncompressed += info.size;
            if (inventory.totalUncompressed > limits.maxTotalUncompressedBytes) {
              throw new ZipRejectedError(
                "ZIP_TOO_LARGE",
                `declared total exceeds ${limits.maxTotalUncompressedBytes} bytes`,
              );
            }
            const key = info.path.toLowerCase();
            if (!info.isDirectory && info.path) {
              if (lowerSeen.has(key)) {
                inventory.warnings.push(`ZIP_DUPLICATE_ENTRY: ${info.path} (later copy ignored)`);
              } else {
                lowerSeen.add(key);
                inventory.entries.push(info);
                byPath.set(info.path, entry);
                if (NESTED_ARCHIVE.test(info.path)) inventory.nestedArchives.push(info.path);
              }
            }
            zip.readEntry();
          } catch (error) {
            reject(error);
          }
        });
        zip.readEntry();
      });
    } catch (error) {
      zip.close();
      throw error instanceof ZipRejectedError ? error : mapYauzlError(error as Error);
    }
    if (inventory.nestedArchives.length > 0) {
      inventory.warnings.push(
        `NESTED_ARCHIVES_NOT_EXTRACTED: ${inventory.nestedArchives.slice(0, 10).join(", ")}`,
      );
    }
    return new SafeZip(zip, byPath, inventory, limits);
  }

  has(path: string): boolean {
    return this.byPath.has(path);
  }

  /** Streams one entry, enforcing the per-entry byte cap on *actual* bytes. */
  async openStream(path: string): Promise<Readable> {
    const entry = this.byPath.get(path);
    if (!entry) throw new Error(`no such entry: ${path}`);
    const stream = await new Promise<Readable>((resolve, reject) =>
      this.zip.openReadStream(entry, (error, readable) =>
        error || !readable ? reject(error ?? new Error("no stream")) : resolve(readable),
      ),
    );
    let seen = 0;
    const max = this.limits.maxEntryBytes;
    const cap = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        seen += chunk.length;
        if (seen > max) callback(new ZipRejectedError("ZIP_ENTRY_TOO_LARGE", path));
        else callback(null, chunk);
      },
    });
    stream.on("error", (error: Error) =>
      cap.destroy(error instanceof ZipRejectedError ? error : mapYauzlError(error)),
    );
    return stream.pipe(cap);
  }

  /** Reads an entry fully into memory (only for entries known to be small). */
  async readBuffer(path: string, maxBytes: number): Promise<Buffer> {
    const entry = this.byPath.get(path);
    if (!entry) throw new Error(`no such entry: ${path}`);
    if (entry.uncompressedSize > maxBytes) throw new ZipRejectedError("ZIP_ENTRY_TOO_LARGE", path);
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of await this.openStream(path)) {
      total += (chunk as Buffer).length;
      if (total > maxBytes) throw new ZipRejectedError("ZIP_ENTRY_TOO_LARGE", path);
      chunks.push(chunk as Buffer);
    }
    return Buffer.concat(chunks);
  }

  close(): void {
    this.zip.close();
  }
}
