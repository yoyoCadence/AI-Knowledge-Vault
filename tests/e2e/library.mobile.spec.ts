import { expect, type Page, test } from "@playwright/test";
import { htmlDocument } from "../fixtures/builders";
import { e2eEnv } from "./e2e-env";
import { attempt, login } from "./helpers";

/**
 * No page may scroll sideways on a phone: everything wraps inside the 16 px gutters. Compared
 * with the screen, not innerWidth: a mobile browser zooms out to fit wide content, which makes
 * the layout viewport (innerWidth) grow with it. Callers first wait for something only the page
 * being measured has: links navigate on the client, and a click returns before they do.
 */
async function expectNoHorizontalOverflow(page: Page, where: string) {
  try {
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth - window.screen.width))
      .toBeLessThanOrEqual(0);
  } catch {
    // Name the culprits: the deepest elements whose content is wider than their box.
    const culprits = await page.evaluate(() =>
      Array.from(document.querySelectorAll<HTMLElement>("body *"))
        .filter(
          (el) =>
            el.scrollWidth > el.clientWidth + 1 &&
            el.clientWidth > 0 &&
            getComputedStyle(el).overflowX === "visible" &&
            !Array.from(el.children).some(
              (child) =>
                (child as HTMLElement).scrollWidth > (child as HTMLElement).clientWidth + 1,
            ),
        )
        .slice(0, 5)
        .map(
          (el) =>
            `<${el.tagName.toLowerCase()} class="${el.className}"> ${el.textContent?.slice(0, 40)}`,
        ),
    );
    throw new Error(`horizontal overflow on ${where}:\n${culprits.join("\n")}`);
  }
}

// Long unbroken text is what usually overflows a phone screen: filenames, titles, names, URLs.
// Every one is the attempt's own (see attempt()).
function longNames(run: string) {
  return {
    longName: `mobile-${run}-${"very-long-filename-without-spaces-".repeat(3)}report.html`,
    title: `手機版排版測試 ${run}：一個相當長的研究報告標題，用來確認在窄螢幕上會正確換行`,
    latinTitle: `Unbroken${"Supercalifragilisticexpialidocious".repeat(2)}Title${run}`,
    collection: `Collection${"Unbroken".repeat(10)}${run}`,
    project: `Project${"Unbroken".repeat(18)}${run}`,
  };
}

test.describe("on a phone (Pixel 7)", () => {
  test("navigation, library, search, reading and sharing fit the screen", async ({ page }) => {
    const run = attempt();
    const { longName, title, latinTitle, collection, project } = longNames(run);
    await login(page);
    await page.goto("/import");
    await page.getByTestId("import-file-input").setInputFiles([
      {
        name: longName,
        mimeType: "text/html",
        buffer: Buffer.from(
          htmlDocument({
            title,
            body: `<h2>結論</h2><p>窄螢幕閱讀測試 ${run}。${"https://example.org/".repeat(4)}a-long-path-segment-without-breaks</p>`,
          }),
        ),
      },
      {
        name: `latin-${run}.html`,
        mimeType: "text/html",
        buffer: Buffer.from(
          htmlDocument({
            title: latinTitle,
            body: `<p>${latinTitle} 窄螢幕閱讀 ${run}。</p>`,
          }),
        ),
      },
    ]);
    await page.getByRole("button", { name: "開始上傳" }).click();
    await expect(page.getByTestId("import-summary")).toHaveText(/2 完成/, { timeout: 30_000 });
    await expectNoHorizontalOverflow(page, "/import");

    // Long names: a collection and a project holding the Latin-titled work.
    await page.goto("/");
    await page.getByRole("heading", { name: latinTitle }).click();
    await expect(page.getByRole("heading", { level: 1, name: latinTitle })).toBeVisible();
    const latinId = new URL(page.url()).pathname.split("/")[2]!;
    const origin = { origin: e2eEnv.APP_ORIGIN! };
    const collectionResponse = await page.request.post("/api/collections", {
      headers: origin,
      data: { name: collection },
    });
    expect(collectionResponse.status()).toBe(201);
    const collectionId = ((await collectionResponse.json()) as { collection: { id: string } })
      .collection.id;
    expect(
      (
        await page.request.put(`/api/collections/${collectionId}/items/${latinId}`, {
          headers: origin,
        })
      ).ok(),
    ).toBe(true);
    const projectResponse = await page.request.post("/api/projects", {
      headers: origin,
      data: { title: project },
    });
    expect(projectResponse.status()).toBe(201);
    const projectId = ((await projectResponse.json()) as { project: { id: string } }).project.id;
    expect(
      (
        await page.request.patch(`/api/artifacts/${latinId}`, {
          headers: origin,
          data: { projectId },
        })
      ).ok(),
    ).toBe(true);

    // The artifact page with its long title, project and collection (preview, then reading).
    await page.reload();
    await expect(page.getByRole("heading", { level: 1, name: latinTitle })).toBeVisible();
    await expect(page.getByTestId("collection-picker")).toContainText(collection);
    await expectNoHorizontalOverflow(page, "an artifact with long title, project and collection");
    await page.getByRole("link", { name: "閱讀", exact: true }).click();
    await expect(page.getByTestId("reader")).toContainText("窄螢幕閱讀");
    await expectNoHorizontalOverflow(page, "the same artifact in reading mode");

    // The sidebar is a drawer behind the menu button.
    await page.goto("/");
    await page.getByRole("button", { name: "開啟選單" }).click();
    const drawer = page.getByRole("dialog");
    await drawer.getByRole("link", { name: "標籤" }).click();
    await expect(page).toHaveURL(/\/tags$/);
    await expect(drawer).toBeHidden();
    await expectNoHorizontalOverflow(page, "/tags");

    // The library with the filters open (their selects hold the long names).
    await page.goto(`/?project=${projectId}`);
    await expect(page.getByTestId("library-filters")).toHaveAttribute("open", "");
    await expect(page.getByRole("heading", { name: latinTitle })).toBeVisible();
    await expectNoHorizontalOverflow(page, "the library with filters open");
    await page.goto("/");
    await expect(page.getByRole("heading", { name: title })).toBeVisible();
    await expect(page.getByTestId("library-summary")).toBeVisible();
    await expectNoHorizontalOverflow(page, "the library (with its summary)");
    // The list layout: one row per work, its parts stacked on a phone.
    const layout = page.getByRole("group", { name: "版面" });
    await layout.getByRole("button", { name: "清單" }).click();
    await expect(page.getByTestId("artifact-row").filter({ hasText: latinTitle })).toBeVisible();
    await expectNoHorizontalOverflow(page, "the library as a list");
    await layout.getByRole("button", { name: "格狀" }).click();
    await expect(page.getByTestId("artifact-row")).toHaveCount(0);

    // Search, once both are indexed (indexing runs right after the import).
    await expect(async () => {
      await page.goto(`/?q=${encodeURIComponent(`窄螢幕閱讀 ${run}`)}`);
      await expect(page.getByTestId("snippet")).toHaveCount(2, { timeout: 1_000 });
    }).toPass({ timeout: 30_000 });
    await expectNoHorizontalOverflow(page, "search results");

    await page.goto("/");
    await page.getByRole("heading", { name: title }).click();
    await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible();
    await expectNoHorizontalOverflow(page, "the long-filename artifact (preview)");
    await page.getByRole("link", { name: "閱讀", exact: true }).click();
    await expect(page.getByTestId("reader")).toContainText("窄螢幕閱讀測試");
    await expectNoHorizontalOverflow(page, "the long-filename artifact (reading)");
    await expect(page.getByTestId("share-panel")).toBeVisible();

    // The public reader, as a link's recipient opens it (with the long filename and SHA-256).
    const artifactId = new URL(page.url()).pathname.split("/")[2]!;
    const shared = await page.request.post(`/api/artifacts/${artifactId}/shares`, {
      headers: origin,
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

    for (const [path, name] of [
      ["/collections", collection],
      ["/projects", project],
    ] as const) {
      await page.goto(path);
      await expect(page.getByRole("link", { name })).toBeVisible();
      await expectNoHorizontalOverflow(page, path);
    }
    for (const path of ["/settings", "/settings/usage"]) {
      await page.goto(path);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      await expectNoHorizontalOverflow(page, path);
    }
  });
});
