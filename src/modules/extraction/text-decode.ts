/**
 * Decodes text files without guessing silently (ADR-010): BOM → strict UTF-8 → Big5 (common for
 * older Traditional Chinese files) → windows-1252 as a last resort, always reporting which
 * encoding was used so lossy fallbacks are visible as warnings.
 */
export interface DecodedText {
  text: string;
  encoding: string;
  warnings: string[];
}

function tryDecode(encoding: string, bytes: Uint8Array): string | null {
  try {
    return new TextDecoder(encoding, { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

export function decodeText(bytes: Uint8Array): DecodedText {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return {
      text: new TextDecoder("utf-8").decode(bytes.subarray(3)),
      encoding: "utf-8",
      warnings: [],
    };
  }
  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    return {
      text: new TextDecoder("utf-16le").decode(bytes.subarray(2)),
      encoding: "utf-16le",
      warnings: [],
    };
  }
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    return {
      text: new TextDecoder("utf-16be").decode(bytes.subarray(2)),
      encoding: "utf-16be",
      warnings: [],
    };
  }
  const utf8 = tryDecode("utf-8", bytes);
  if (utf8 !== null) return { text: utf8, encoding: "utf-8", warnings: [] };

  const big5 = tryDecode("big5", bytes);
  if (big5 !== null) {
    return {
      text: big5,
      encoding: "big5",
      warnings: ["TEXT_ENCODING_FALLBACK: decoded as Big5 (not valid UTF-8)"],
    };
  }
  return {
    text: new TextDecoder("windows-1252").decode(bytes),
    encoding: "windows-1252",
    warnings: [
      "TEXT_ENCODING_FALLBACK: not valid UTF-8 or Big5; decoded as windows-1252 (may be lossy)",
    ],
  };
}
