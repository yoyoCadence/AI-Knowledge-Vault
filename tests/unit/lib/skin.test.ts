import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  ArtifactCard,
  ArtifactRow,
  type ArtifactCardData,
} from "@/components/library/artifact-card";
import { Button } from "@/components/ui/button";
import { CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/states";
import { DEFAULT_SKIN, skinOf } from "@/lib/skin";

const artifact: ArtifactCardData = {
  id: "00000000-0000-4000-8000-000000000001",
  title: "都市熱島報告",
  summary: null,
  visibility: "private",
  createdAt: "2026-10-01T00:00:00.000Z",
  versionCount: 1,
  hasThumbnail: true,
  contentKind: "image",
  sourcePlatform: null,
  sourceModel: null,
  tags: [],
  readingStatus: "unread",
  isFavorite: false,
};

describe("skin choice", () => {
  it("keeps plain, and anything else is the default archive skin", () => {
    expect(DEFAULT_SKIN).toBe("archive");
    expect(skinOf("plain")).toBe("plain");
    expect(skinOf("archive")).toBe("archive");
    for (const value of [undefined, "", "PLAIN", "dark", "archive; path=/"]) {
      expect(skinOf(value)).toBe("archive");
    }
  });
});

describe("hooks the archive skin dresses", () => {
  it("marks catalogue cards, rows, card titles, buttons and empty states", () => {
    const card = renderToStaticMarkup(createElement(ArtifactCard, { artifact }));
    expect(card).toContain('data-slot="catalog-card"');
    expect(card).toContain('data-slot="catalog-thumb"');
    expect(card).toContain('data-slot="catalog-body"');
    expect(renderToStaticMarkup(createElement(ArtifactRow, { artifact }))).toContain(
      'data-slot="catalog-row"',
    );
    expect(renderToStaticMarkup(createElement(CardTitle, null, "閱讀模式"))).toContain(
      'data-slot="card-title"',
    );
    expect(renderToStaticMarkup(createElement(Button, null, "匯入"))).toContain(
      'data-variant="default"',
    );
    expect(renderToStaticMarkup(createElement(Button, { variant: "outline" }, "取消"))).toContain(
      'data-variant="outline"',
    );
    expect(renderToStaticMarkup(createElement(EmptyState, { title: "空的" }))).toContain(
      'data-slot="empty-state"',
    );
  });
});

describe("archive skin stylesheet", () => {
  const css = readFileSync(
    path.join(process.cwd(), "src/app/_skins/archive/archive.css"),
    "utf8",
  ).replace(/\/\*[\s\S]*?\*\//g, "");

  it("never restyles user images or previews", () => {
    // Thumbnails, reading-mode images and the sandboxed preview are shown as stored.
    expect(css).not.toMatch(/\bimg\b|\bpicture\b|\bvideo\b|iframe|preview/);
    expect(css).not.toMatch(/(?<!backdrop-)filter\s*:/);
    expect(css).not.toMatch(/mix-blend-mode/);
  });

  it("scopes every rule to the archive skin", () => {
    // The text before each rule's "{" (inside an @media block too: its own "{" comes first).
    const selectors = css
      .split("}")
      .map((block) => block.split("{").at(-2)?.trim() ?? "")
      .filter((selector) => selector && !selector.startsWith("@"));
    expect(selectors.length).toBeGreaterThan(40);
    for (const selector of selectors) {
      for (const part of selector.split(/,(?![^(]*\))/)) {
        expect(part.trim(), part).toMatch(/^:root\[data-skin="archive"\]/);
      }
    }
  });

  it("keeps decoration out of the way of pointers", () => {
    for (const slot of ["cabinet-shelf", "cornice", "scene"]) {
      const rule = css.match(new RegExp(`\\[data-slot="${slot}"\\] \\{[^}]*\\}`, "g")) ?? [];
      expect(rule.join(""), slot).toContain("pointer-events: none");
    }
  });
});
