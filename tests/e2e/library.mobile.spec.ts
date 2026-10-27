import { expect, type Page, test } from "@playwright/test";
import { htmlDocument } from "../fixtures/builders";
import { e2eEnv } from "./e2e-env";
import { login } from "./helpers";

/**
 * No page may scroll sideways on a phone: everything wraps inside the 16 px gutters. Compared
 * with the screen, not innerWidth: a mobile browser zooms out to fit wide content, which makes
 * the layout viewport (innerWidth) grow with it.
 */
async function expectNoHorizontalOverflow(page: Page, where: string) {
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth - window.screen.width), {
      message: `horizontal overflow on ${where}`,
    })
    .toBeLessThanOrEqual(0);
}

// Long unbroken text is what usually overflows a phone screen: filenames, hashes, URLs.
const LONG_NAME = `mobile-${"very-long-filename-without-spaces-".repeat(3)}report.html`;
const TITLE = "手機版排版測試：一個相當長的研究報告標題，用來確認在窄螢幕上會正確換行";
const LATIN_TITLE = `Unbroken${"Supercalifragilisticexpialidocious".repeat(2)}Title`;

test.describe("on a phone (Pixel 7)", () => {
  test("navigation, library, search, reading and sharing fit the screen", async ({ page }) => {
    await login(page);
    await page.goto("/import");
    await page.getByTestId("import-file-input").setInputFiles([
      {
        name: LONG_NAME,
        mimeType: "text/html",
        buffer: Buffer.from(
          htmlDocument({
            title: TITLE,
            body: `<h2>結論</h2><p>窄螢幕閱讀測試。${"https://example.org/".repeat(4)}a-long-path-segment-without-breaks</p>`,
          }),
        ),
      },
      {
        name: "latin.html",
        mimeType: "text/html",
        buffer: Buffer.from(
          htmlDocument({ title: LATIN_TITLE, body: `<p>${LATIN_TITLE} 窄螢幕閱讀。</p>` }),
        ),
      },
    ]);
    await page.getByRole("button", { name: "開始上傳" }).click();
    await expect(page.getByTestId("import-summary")).toHaveText(/2 完成/, { timeout: 30_000 });
    await expectNoHorizontalOverflow(page, "/import");

    // The sidebar is a drawer behind the menu button.
    await page.goto("/");
    await expect(page.getByRole("navigation", { name: "Main" })).toBeHidden();
    await page.getByRole("button", { name: "開啟選單" }).click();
    const drawer = page.getByRole("dialog");
    await drawer.getByRole("link", { name: "標籤" }).click();
    await expect(page).toHaveURL(/\/tags$/);
    await expect(drawer).toBeHidden();
    await expectNoHorizontalOverflow(page, "/tags");

    await page.goto("/");
    await expect(page.getByRole("heading", { name: TITLE })).toBeVisible();
    await expectNoHorizontalOverflow(page, "the library");

    await page.goto(`/?q=${encodeURIComponent("窄螢幕閱讀")}`);
    await expect(page.getByRole("link", { name: new RegExp(TITLE.slice(0, 8)) })).toBeVisible();
    await expectNoHorizontalOverflow(page, "search results");

    await page.goto("/");
    await page.getByRole("heading", { name: LATIN_TITLE }).click();
    await expectNoHorizontalOverflow(page, "an artifact with an unbroken Latin title");
    await page.goto("/");
    await page.getByRole("heading", { name: TITLE }).click();
    await page.getByRole("link", { name: "閱讀", exact: true }).click();
    await expect(page.getByTestId("reader")).toContainText("窄螢幕閱讀測試");
    await expectNoHorizontalOverflow(page, "the artifact page (reading)");
    await expect(page.getByTestId("share-panel")).toBeVisible();

    // The public reader, as a link's recipient opens it (with the long filename and SHA-256).
    const artifactId = new URL(page.url()).pathname.split("/")[2]!;
    const shared = await page.request.post(`/api/artifacts/${artifactId}/shares`, {
      headers: { origin: e2eEnv.APP_ORIGIN! },
      data: {
        allowPreview: true,
        allowReading: true,
        allowDownload: true,
        expiresInDays: 1,
        acknowledgeFindings: true,
      },
    });
    expect(shared.status()).toBe(201);
    await page.goto(((await shared.json()) as { url: string }).url + "?view=read");
    await expect(page.getByTestId("share-download")).toBeVisible();
    await expectNoHorizontalOverflow(page, "the public share reader");

    for (const path of ["/collections", "/projects", "/settings", "/settings/usage"]) {
      await page.goto(path);
      await expectNoHorizontalOverflow(page, path);
    }
  });
});
