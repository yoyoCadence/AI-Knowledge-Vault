import { describe, expect, it } from "vitest";
import { linkDestinations, scanShareText, suspiciousFiles } from "@/modules/sharing/scan";

// Built at run time, so no secret scanner mistakes the fixtures for real credentials.
const fake = {
  openai: ["sk", "proj", "x".repeat(32)].join("-"),
  aws: `AK${"IA"}${"QWERTYUIOP123456"}`,
  github: `gh${"p_"}${"a1".repeat(18)}`,
  slack: `xo${"xb"}-${"1234567890-abcdef"}`,
  google: `AI${"za"}${"b".repeat(35)}`,
  jwt: [
    `ey${"J"}hbGciOiJIUzI1NiJ9`,
    "eyJzdWIiOiIxMjM0NTY3ODkwIn0",
    "c2lnbmF0dXJlLXNpZ25hdHVyZQ",
  ].join("."),
  pem: ["-----BEGIN", "RSA PRIVATE KEY-----"].join(" "),
};

const kinds = (text: string) => scanShareText(text).map((finding) => finding.kind);

describe("pre-share scan (FR-SHR-3)", () => {
  it("finds well-known keys and tokens, and shows them masked", () => {
    for (const [name, secret] of Object.entries(fake)) {
      const [finding] = scanShareText(`設定：${secret} 請勿外流`);
      expect(finding?.kind, name).toBe("secret");
      expect(finding?.count, name).toBe(1);
      expect(finding?.samples[0], name).not.toContain(secret.slice(4, -2));
      expect(finding?.samples[0]?.startsWith(secret.slice(0, 4)), name).toBe(true);
    }
  });

  it("finds email addresses and intranet URLs, not public ones", () => {
    expect(kinds("聯絡 someone.name+tag@example.co.uk 取得資料")).toEqual(["email"]);
    for (const url of [
      "http://localhost:3000/admin",
      "https://127.0.0.1/x",
      "http://10.1.2.3/",
      "http://192.168.0.10:8080",
      "https://172.16.4.5/wiki",
      "https://172.31.255.1/",
      "https://wiki.corp/page",
      "http://jira.internal/browse/X-1",
      "http://printer.local",
      "http://printer.local.",
      "http://LOCALHOST/",
    ]) {
      expect(kinds(`參考 ${url} 這頁`), url).toEqual(["private_url"]);
    }
    for (const url of [
      "https://example.com/a",
      "https://172.32.0.1/",
      "https://localhost.example.com",
    ]) {
      expect(kinds(`參考 ${url} 這頁`), url).toEqual([]);
    }
  });

  it("counts every match and keeps at most three samples", () => {
    const text = Array.from({ length: 5 }, (_, i) => `user${i}@example.org`).join("，");
    expect(scanShareText(text)).toEqual([
      { kind: "email", count: 5, samples: expect.any(Array) as unknown },
    ]);
    expect(scanShareText(text)[0]!.samples).toHaveLength(3);
  });

  it("reports nothing for ordinary research text", () => {
    expect(
      scanShareText("濕地鳥類調查報告：2024 年共記錄 132 種。參考 https://www.gbif.org/ 的資料。"),
    ).toEqual([]);
  });

  it("flags preview files that usually hold secrets", () => {
    const flagged = [
      ".env",
      "app/.env.local",
      ".git/config",
      "keys/id_rsa",
      "id_ed25519.pub",
      "certs/server.pem",
      "tls.key",
      "store.p12",
      "credentials",
      "aws/credentials.json",
      "secrets.yaml",
      "config/secret.env",
      ".npmrc",
    ];
    const harmless = ["environment.html", "keynote.html", "docs/env.md", "index.html", "keys.md"];
    const finding = suspiciousFiles([...flagged, ...harmless]);
    expect(finding).toMatchObject({ kind: "suspicious_file", count: flagged.length });
    expect(finding?.samples).toEqual(flagged.slice(0, 3));
    expect(suspiciousFiles(harmless)).toBeNull();
  });

  it("extracts link and image destinations from normalized Markdown", () => {
    const markdown = [
      '見[內部報告](https://wiki.internal/report "標題")與![圖](http://10.0.0.5/a.png)。',
      "寫信給<mailto:alice@example.com>，或 <https://example.org/x>。",
      "[ref]: http://jira.corp/browse/A-1",
      "  [two]: <https://intranet.local/b>",
      "[純文字] (不是連結) 與 [空的]()",
    ].join("\n");
    expect(linkDestinations(markdown)).toEqual([
      "https://wiki.internal/report",
      "http://10.0.0.5/a.png",
      "mailto:alice@example.com",
      "https://example.org/x",
      "http://jira.corp/browse/A-1",
      "https://intranet.local/b",
    ]);
    expect(linkDestinations("沒有連結的段落。")).toEqual([]);
  });

  it("stays fast on adversarial text of the maximum scanned size", { timeout: 30_000 }, () => {
    const size = 2_000_000;
    for (const unit of [
      "a@",
      "a.",
      "sk-a",
      "http://a.",
      "eyJaaaaaaaa.",
      "-----BEGIN A ",
      "x@a.a",
      "](",
      "](<a",
      "<a:",
      "<aaaaaaaa",
      "[a]",
    ]) {
      const text = unit.repeat(Math.ceil(size / unit.length)).slice(0, size);
      const started = performance.now();
      scanShareText(text);
      linkDestinations(text);
      // About 1.2 s before the email pattern was anchored; tens of milliseconds after.
      expect(performance.now() - started, unit).toBeLessThan(600);
    }
  });
});
