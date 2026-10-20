import { describe, expect, it } from "vitest";
import {
  ChecksumFormatError,
  exportFilename,
  formatChecksums,
  hashFromOriginalPath,
  isPortablePath,
  originalPath,
  parseChecksums,
  sanitizeArchiveFilename,
} from "@/modules/backup/format";

const HASH = "a".repeat(64);
const OTHER = "b".repeat(64);

describe("export format v1 helpers", () => {
  it("builds content-addressed original paths and reads the hash back", () => {
    const entry = originalPath(HASH, "研究報告 (1).md");
    expect(entry).toBe(`originals/aa/${HASH}/研究報告 (1).md`);
    expect(hashFromOriginalPath(entry)).toBe(HASH);
    expect(hashFromOriginalPath(`originals/ab/${HASH}/x`)).toBeNull(); // prefix must match
    expect(hashFromOriginalPath("metadata/artifacts.json")).toBeNull();
    expect(() => originalPath("not-a-hash", "x")).toThrow();
  });

  it("sanitizes original names into one safe segment", () => {
    expect(sanitizeArchiveFilename("../../etc/passwd")).toBe("__.._etc_passwd");
    expect(sanitizeArchiveFilename("a\nb\\c")).toBe("a_b_c");
    expect(sanitizeArchiveFilename("...")).toBe("_");
    expect(sanitizeArchiveFilename("")).toBe("original");
    expect(isPortablePath(originalPath(HASH, "../../evil"))).toBe(true);
  });

  it("writes and strictly parses GNU sha256sum format", () => {
    const text = formatChecksums([
      { path: "b.json", sha256: OTHER },
      { path: "a.json", sha256: HASH },
    ]);
    expect(text).toBe(`${HASH}  a.json\n${OTHER}  b.json\n`);
    expect(parseChecksums(text)).toEqual(
      new Map([
        ["a.json", HASH],
        ["b.json", OTHER],
      ]),
    );
    expect(parseChecksums(`${HASH} *binary.bin\n`).get("binary.bin")).toBe(HASH);
    for (const bad of [
      `${HASH} a.json\n`, // single space
      `${HASH}  ../escape\n`,
      `${HASH}  /abs\n`,
      `${HASH}  a.json\n${OTHER}  a.json\n`,
      "zz  a.json\n",
    ]) {
      expect(() => parseChecksums(bad), bad).toThrow(ChecksumFormatError);
    }
    expect(() => formatChecksums([{ path: "bad\nname", sha256: HASH }])).toThrow();
  });

  it("names exports with the workspace slug and a UTC timestamp", () => {
    expect(exportFilename("me", new Date("2026-10-20T08:09:10.123Z"))).toBe(
      "knowledge-vault-export-me-20261020T080910Z.zip",
    );
  });
});
