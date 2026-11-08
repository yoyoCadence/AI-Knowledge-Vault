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
  /**
   * The name's bytes as written, for archives from tools that write their own encoding: macOS
   * writes UTF-8 without the UTF-8 flag, Windows in a zh-TW locale writes Big5. Default: `name`
   * as UTF-8.
   */
  nameBytes?: Buffer;
  /** General-purpose bit 11, "the name is UTF-8". Default true. */
  utf8Flag?: boolean;
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
    const name = spec.nameBytes ?? Buffer.from(spec.name, "utf8");
    // UTF-8 names (unless told otherwise), + encrypted.
    const flags = (spec.utf8Flag === false ? 0 : 0x0800) | (spec.encrypted ? 0x0001 : 0);
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

/** Breaks the local file header signature of one entry (yauzl only notices when it is read). */
export function corruptLocalHeader(zip: Buffer, entryName: string): Buffer {
  const copy = Buffer.from(zip);
  const at = copy.indexOf(Buffer.from(entryName, "utf8")) - 30;
  if (at < 0 || copy.readUInt32LE(at) !== 0x04034b50)
    throw new Error(`no local header for ${entryName}`);
  copy.writeUInt32LE(0xdeadbeef, at);
  return copy;
}

let big5Codes: Map<string, Buffer> | undefined;

/**
 * Text as Big5 bytes, as Windows in a zh-TW locale writes ZIP entry names. Test-only: built
 * once by decoding every two-byte Big5 code (Node has a Big5 decoder, not an encoder).
 */
export function big5(text: string): Buffer {
  if (!big5Codes) {
    const codes = new Map<string, Buffer>();
    const decoder = new TextDecoder("big5");
    for (let lead = 0x81; lead <= 0xfe; lead += 1) {
      for (let trail = 0x40; trail <= 0xfe; trail += 1) {
        if (trail > 0x7e && trail < 0xa1) continue;
        const bytes = Buffer.from([lead, trail]);
        const char = decoder.decode(bytes);
        if ([...char].length === 1 && char !== "\ufffd" && !codes.has(char)) codes.set(char, bytes);
      }
    }
    big5Codes = codes;
  }
  const codes = big5Codes;
  return Buffer.concat(
    [...text].map((char) => {
      if (char.charCodeAt(0) < 0x80) return Buffer.from(char, "ascii");
      const bytes = codes.get(char);
      if (!bytes) throw new Error(`not in Big5: ${char}`);
      return bytes;
    }),
  );
}
