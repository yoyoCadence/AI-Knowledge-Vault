import { describe, expect, it } from "vitest";
import { identityKeyFor, isDistinctiveKey } from "@/modules/artifacts";
import { canTransition, sanitizeFilename } from "@/modules/imports";

describe("identityKeyFor (version matching)", () => {
  it.each([
    ["Morphogenesis_Report_Design.zip", "morphogenesis report design"],
    ["Morphogenesis_Report_Design (1).zip", "morphogenesis report design"],
    ["Morphogenesis Report Design copy.zip", "morphogenesis report design"],
    ["morphogenesis-report-design_v2.zip", "morphogenesis report design"],
    ["Morphogenesis Report Design-2026-10-20.zip", "morphogenesis report design"],
    ["Morphogenesis Report.dc.html", "morphogenesis report"],
    ["ＡＩ代理人組織研究 副本.html", "ai代理人組織研究"],
  ])("%s → %s", (filename, expected) => {
    expect(identityKeyFor(filename)).toBe(expected);
  });

  it("marks generic and short names as non-distinctive", () => {
    for (const name of ["index.html", "report.pdf", "Untitled.md", "a.txt", "design (2).zip"]) {
      expect(isDistinctiveKey(identityKeyFor(name))).toBe(false);
    }
    expect(isDistinctiveKey(identityKeyFor("Quarterly Market Study.pdf"))).toBe(true);
  });
});

describe("sanitizeFilename", () => {
  it("strips paths and control characters but keeps unicode", () => {
    expect(sanitizeFilename("../../etc/passwd")).toBe("passwd");
    expect(sanitizeFilename("C:\\Users\\me\\報告.pdf")).toBe("報告.pdf");
    expect(sanitizeFilename("bad\u0000name\u0007.html")).toBe("badname.html");
    expect(sanitizeFilename("...hidden.md")).toBe("hidden.md");
    expect(sanitizeFilename("   ")).toBe("untitled");
  });

  it("caps length at 255 bytes while keeping the extension", () => {
    const name = sanitizeFilename(`${"研".repeat(200)}.html`);
    expect(Buffer.byteLength(name)).toBeLessThanOrEqual(255);
    expect(name.endsWith(".html")).toBe(true);
  });
});

describe("import item state machine", () => {
  it("allows the happy path and retries, forbids resurrection", () => {
    expect(canTransition("awaiting_upload", "queued")).toBe(true);
    expect(canTransition("queued", "processing")).toBe(true);
    expect(canTransition("processing", "succeeded")).toBe(true);
    expect(canTransition("failed", "queued")).toBe(true);
    expect(canTransition("succeeded", "queued")).toBe(false);
    expect(canTransition("duplicate", "processing")).toBe(false);
    expect(canTransition("cancelled", "queued")).toBe(false);
  });
});
