import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  ArtifactCard,
  type ArtifactCardData,
  ArtifactRow,
} from "@/components/library/artifact-card";
import { libraryLayout } from "@/lib/library-layout";

const artifact: ArtifactCardData = {
  id: "00000000-0000-4000-8000-000000000001",
  title: "都市熱島報告",
  summary: "只在卡片上顯示的摘要",
  visibility: "private",
  createdAt: "2026-10-01T00:00:00.000Z",
  versionCount: 3,
  hasThumbnail: true,
  contentKind: "pdf",
  sourcePlatform: "claude",
  sourceModel: "example-model-9",
  tags: ["城市", "氣候", "熱島", "第四個"],
  readingStatus: "reading",
  isFavorite: true,
};

describe("library layouts", () => {
  it("a row shows what a card shows, without the thumbnail and summary", () => {
    const card = renderToStaticMarkup(createElement(ArtifactCard, { artifact }));
    const row = renderToStaticMarkup(createElement(ArtifactRow, { artifact }));
    for (const html of [card, row]) {
      expect(html).toContain(`href="/artifacts/${artifact.id}"`);
      expect(html).toContain("都市熱島報告");
      expect(html).toContain("PDF");
      expect(html).toContain("3 個版本");
      expect(html).toContain("#城市");
      expect(html).toContain('data-testid="reading-badge"');
      expect(html).toContain("Claude"); // the platform
      expect(html).toContain("example-model-9"); // the source model (FR-LIB-2)
      expect(html).toContain("2026年10月1日");
      expect(html).toContain("私人");
      expect(html).toMatch(/<span class="sr-only">收藏: <\/span>/);
    }
    expect(card).toContain("/thumbnail");
    expect(card).toContain("只在卡片上顯示的摘要");
    expect(row).not.toContain("/thumbnail");
    expect(row).not.toContain("只在卡片上顯示的摘要");
    expect(row).toContain('data-testid="artifact-row"');
  });

  it("reads the layout cookie: list, or else the grid", () => {
    expect(libraryLayout("list")).toBe("list");
    for (const value of [undefined, "", "grid", "LIST", "list; other=1"]) {
      expect(libraryLayout(value)).toBe("grid");
    }
  });
});
