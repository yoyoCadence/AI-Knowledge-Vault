import { describe, expect, it } from "vitest";
import { linkableUrl } from "@/lib/url";

describe("linkableUrl", () => {
  it("returns the parsed address of a credential-free http(s) URL", () => {
    expect(linkableUrl(" https://example.org/研究?q=1 ")).toBe(
      "https://example.org/%E7%A0%94%E7%A9%B6?q=1",
    );
    expect(linkableUrl("http://example.org")).toBe("http://example.org/");
  });

  it("refuses other schemes, credentials and what does not parse", () => {
    for (const value of [
      "javascript:alert(1)",
      "mailto:a@example.org",
      "ftp://example.org/",
      "https://trusted.example@evil.example/",
      "https://user:pass@example.org/",
      "/relative",
      "http://%zz/report",
      "",
    ]) {
      expect(linkableUrl(value), value).toBeNull();
    }
  });
});
