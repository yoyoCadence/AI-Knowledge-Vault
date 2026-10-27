import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { LibrarySummary } from "@/components/library/library-summary";
import type { LibrarySummary as Summary } from "@/modules/ops";

const base: Summary = {
  library: { artifacts: 12, versions: 15 },
  kinds: [
    { kind: "html_document", count: 9 },
    { kind: "markdown", count: 3 },
  ],
  originals: { count: 15, bytes: 2_048, missing: 0, corrupt: 0 },
  lastExportAt: null,
  lastIntegrityCheckAt: null,
};

const render = (
  summary: Partial<Summary>,
  roles: { canSeeUsage?: boolean; canSeeExports?: boolean } = {},
) =>
  renderToStaticMarkup(
    createElement(LibrarySummary, {
      summary: { ...base, ...summary },
      canSeeUsage: roles.canSeeUsage ?? false,
      canSeeExports: roles.canSeeExports ?? false,
    }),
  );

describe("LibrarySummary (FR-LIB-1)", () => {
  it("shows the counts, and each kind as a link to its filter", () => {
    const html = render({});
    expect(html).toContain("12 份作品");
    expect(html).toContain("15 個版本");
    expect(html).toContain('href="/?kind=markdown"');
    expect(html).toContain("Markdown 3");
  });

  it("claims nothing about the originals before an integrity check has completed", () => {
    const html = render({});
    expect(html).toContain("保存狀態：尚未執行完整性檢查");
    expect(html).not.toContain("未發現遺失或損毀");
    const checked = render({ lastIntegrityCheckAt: new Date("2026-10-01T00:00:00Z") });
    expect(checked).toContain("保存狀態：未發現遺失或損毀的原始檔");
    expect(checked).toContain("上次完整性檢查");
  });

  it("names only the problems found, even when no check has completed since", () => {
    const html = render({ originals: { ...base.originals, missing: 0, corrupt: 2 } });
    expect(html).toContain("保存狀態：2 個原始檔損毀");
    expect(html).not.toContain("遺失");
    expect(html).toContain("text-danger");
    const both = render({ originals: { ...base.originals, missing: 1, corrupt: 2 } });
    expect(both).toContain("保存狀態：1 個原始檔遺失、2 個原始檔損毀");
  });

  it("shows exports only to roles that can export, and the usage link only to owners", () => {
    const exported = { lastExportAt: new Date("2026-10-02T00:00:00Z") };
    expect(render(exported)).not.toContain("匯出");
    expect(render(exported, { canSeeExports: true })).toContain("上次建立匯出");
    expect(render({}, { canSeeExports: true })).toContain("尚未建立匯出");
    expect(render({})).not.toContain("/settings/usage");
    expect(render({}, { canSeeUsage: true })).toContain('href="/settings/usage"');
  });
});
