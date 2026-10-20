import { crc32, deflateRawSync } from "node:zlib";

/**
 * Minimal ZIP writer for tests. Unlike real zip libraries it happily produces *malicious*
 * archives (traversal names, symlinks, encrypted flags, lying sizes) so the reader's defenses can
 * be tested. Never used in application code.
 */
export interface ZipEntrySpec {
  name: string;
  data?: Buffer | string;
  method?: "store" | "deflate";
  /** Unix mode bits stored in the external attributes (e.g. 0o120777 for a symlink). */
  mode?: number;
  /** Sets general-purpose bit 0 (encrypted) without real encryption. */
  encrypted?: boolean;
  /** Overrides the uncompressed size written in the headers (to simulate lying headers). */
  declaredSize?: number;
}

export function buildZip(entries: ZipEntrySpec[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const spec of entries) {
    const raw =
      typeof spec.data === "string" ? Buffer.from(spec.data) : (spec.data ?? Buffer.alloc(0));
    const isDirectory = spec.name.endsWith("/");
    const method = isDirectory ? 0 : spec.method === "deflate" ? 8 : 0;
    const body = method === 8 ? deflateRawSync(raw) : raw;
    const name = Buffer.from(spec.name, "utf8");
    const flags = 0x0800 | (spec.encrypted ? 0x0001 : 0); // UTF-8 names (+ encrypted)
    const checksum = crc32(raw);
    const uncompressed = spec.declaredSize ?? raw.length;
    const mode = spec.mode ?? (isDirectory ? 0o40755 : 0o100644);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10); // time
    local.writeUInt16LE(0x21, 12); // date (1980-01-01)
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(uncompressed, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4); // made by: Unix
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(uncompressed, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk
    central.writeUInt16LE(0, 36); // internal attrs
    central.writeUInt32LE((mode << 16) >>> 0, 38); // external attrs
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += local.length + name.length + body.length;
  }

  const centralDirectory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, centralDirectory, end]);
}
