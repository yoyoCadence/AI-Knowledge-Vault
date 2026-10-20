import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ReadingBody } from "@/components/reader/reading-body";

const render = (props: Partial<Parameters<typeof ReadingBody>[0]>) =>
  renderToStaticMarkup(
    createElement(ReadingBody, {
      artifactId: "a",
      title: "圖",
      version: { contentKind: "image", processingStatus: "ready" },
      hasThumbnail: true,
      content: null,
      ...props,
    }),
  );

describe("ReadingBody for images", () => {
  it("shows the thumbnail only when it exists", () => {
    expect(render({})).toContain('src="/api/artifacts/a/thumbnail"');
  });

  it("says the image is still processing instead of showing a broken image", () => {
    const html = render({
      hasThumbnail: false,
      version: { contentKind: "image", processingStatus: "pending" },
    });
    expect(html).not.toContain("<img");
    expect(html).toContain("內容仍在處理中");
  });

  it("says the thumbnail is missing when processing has finished without one", () => {
    const html = render({
      hasThumbnail: false,
      version: { contentKind: "image", processingStatus: "failed" },
    });
    expect(html).not.toContain("<img");
    expect(html).toContain("這張圖片還沒有縮圖");
  });
});
