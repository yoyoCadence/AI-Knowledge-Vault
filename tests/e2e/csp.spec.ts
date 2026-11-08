import { type Browser, expect, type Page, test } from "@playwright/test";
import { htmlDocument } from "../fixtures/builders";
import { attempt, login, SIGNED_OUT } from "./helpers";

/**
 * The app origin's Content-Security-Policy (docs/SECURITY.md §11, proxy.ts): every page still
 * runs its own scripts (Next.js and the theme script carry the request's nonce), and nothing
 * else runs, even when markup slips into a page.
 */

type Watched = Window & { __cspViolations?: string[]; __injected?: number; __handler?: number };

/** Records the top frame's CSP violations, from before any of the page's own scripts run. */
async function watchViolations(page: Page) {
  await page.addInitScript(() => {
    if (window.top !== window) return;
    const seen: string[] = [];
    (window as Watched).__cspViolations = seen;
    document.addEventListener("securitypolicyviolation", (event) => {
      seen.push(`${event.effectiveDirective} ${event.blockedURI || "inline"} @${event.sourceFile}`);
    });
  });
}

const violations = (page: Page) =>
  page.evaluate(() => (window as Watched).__cspViolations ?? ["(not watched)"]);

/** The page's response carries a nonce policy, its scripts ran, and none was refused. */
async function expectScriptsRanUnderPolicy(page: Page, path: string) {
  const response = await page.goto(path);
  const policy = response?.headers()["content-security-policy"] ?? "";
  expect(policy, path).toMatch(/script-src 'self' 'nonce-[A-Za-z0-9+/]{24}' 'strict-dynamic'/);
  expect(policy, path).toContain("object-src 'none'");
  expect(policy, path).toContain("frame-ancestors 'none'");
  // goto waited for `load`, so every script in the HTML has been tried; Next.js's client
  // runtime sets `window.next` once its scripts run. (Not "networkidle": a page that polls,
  // like a library with an import in progress, never gets there.)
  await expect.poll(() => page.evaluate(() => "next" in window), { message: path }).toBe(true);
  expect(await violations(page), path).toEqual([]);
}

async function importDocument(page: Page, title: string) {
  await page.goto("/import");
  await page.getByTestId("import-file-input").setInputFiles([
    {
      name: `csp-${attempt()}.html`,
      mimeType: "text/html",
      buffer: Buffer.from(htmlDocument({ title, body: `<p>內容安全政策 ${attempt()}</p>` })),
    },
  ]);
  await page.getByRole("button", { name: "開始上傳" }).click();
  await expect(page.getByTestId("import-summary")).toHaveText(/1 完成/, { timeout: 30_000 });
  await page.goto("/");
  await page.getByRole("heading", { name: title }).click();
  await page.waitForURL(/\/artifacts\/[^/?]+$/);
  return new URL(page.url()).pathname;
}

async function shareUrl(page: Page): Promise<string> {
  const panel = page.getByTestId("share-panel");
  await panel.getByRole("button", { name: "建立分享連結" }).click();
  await panel.getByRole("button", { name: "確認建立" }).click();
  return panel.getByTestId("share-url").inputValue();
}

async function signedOutPage(browser: Browser) {
  const context = await browser.newContext({ storageState: SIGNED_OUT });
  const page = await context.newPage();
  await watchViolations(page);
  return { context, page };
}

test.describe("content security policy", () => {
  test("every page runs its own scripts under the policy, and none is refused", async ({
    page,
    browser,
  }) => {
    test.slow(); // about twenty page loads, an import and a share
    await watchViolations(page);
    await login(page);
    const detail = await importDocument(page, `內容安全政策測試 ${attempt()}`);
    // The preview frame is on the preview origin: framing it is not restricted.
    await expect(page.getByTestId("preview-frame")).toBeVisible();
    for (const path of [
      "/",
      "/?q=熱島",
      detail,
      `${detail}?view=read`,
      "/import",
      "/collections",
      "/projects",
      "/tags",
      "/showcase",
      "/knowledge-map",
      "/ai-research",
      "/settings",
      "/settings/usage",
      "/settings/deleted",
      "/artifacts/00000000-0000-4000-8000-000000000000", // not found
    ]) {
      await expectScriptsRanUnderPolicy(page, path);
    }

    // The theme script ran before paint, and the toggle works once the page is hydrated:
    // system → light → dark.
    await page.goto("/settings");
    expect(await page.evaluate(() => document.documentElement.className)).toMatch(
      /\b(light|dark)\b/,
    );
    const toggle = page.getByRole("button", { name: /^切換深色／淺色模式/ });
    await toggle.click();
    await expect(toggle).toHaveAccessibleName(/淺色/);
    await toggle.click();
    await expect(page.locator("html")).toHaveClass(/\bdark\b/);
    expect(await violations(page)).toEqual([]);

    // Pages for visitors: the login page and a shared work.
    await page.goto(detail);
    const url = await shareUrl(page);
    const visitor = await signedOutPage(browser);
    await expectScriptsRanUnderPolicy(visitor.page, "/login");
    await expectScriptsRanUnderPolicy(visitor.page, url);
    await visitor.context.close();
  });

  test("markup that slips into a page cannot run script", async ({ page }) => {
    await watchViolations(page);
    await login(page);
    // As if stored markup reached the HTML: a script and an inline handler without the nonce.
    await page.route("**/", async (route) => {
      if (route.request().resourceType() !== "document") return route.continue();
      const response = await route.fetch();
      const html = (await response.text()).replace(
        "</body>",
        `<script>window.__injected = 1</script><img src="/nope.png" onerror="window.__handler = 1"></body>`,
      );
      await route.fulfill({ response, body: html });
    });
    await page.goto("/");
    // The page's own scripts still run.
    await expect.poll(() => page.evaluate(() => "next" in window)).toBe(true);
    // Both are refused: the script while the page is parsed, the handler once the image fails.
    await expect
      .poll(async () =>
        (await violations(page))
          .filter((line) => /^script-src-(elem|attr) inline/.test(line))
          .map((line) => line.split(" ")[0])
          .sort(),
      )
      .toEqual(["script-src-attr", "script-src-elem"]);
    expect(
      await page.evaluate(() => [(window as Watched).__injected, (window as Watched).__handler]),
    ).toEqual([undefined, undefined]);

    // Markup added later (a DOM sink) gets no further: a handler attribute is refused too.
    await page.unrouteAll();
    await page.evaluate(() => {
      const holder = document.createElement("div");
      holder.innerHTML = `<img src="/nope-too.png" onerror="window.__handler = 2">`;
      document.body.append(holder);
    });
    await expect
      .poll(async () =>
        (await violations(page)).filter((line) => line.startsWith("script-src-attr")),
      )
      .toHaveLength(2);
    expect(await page.evaluate(() => (window as Watched).__handler)).toBeUndefined();
  });
});
