import { expect, test } from "@playwright/test";
import { htmlDocument } from "../fixtures/builders";
import { attempt, login } from "./helpers";

test.describe("import into a project and a collection", () => {
  test("the works of a batch land in the project and collection chosen on the import page", async ({
    page,
  }) => {
    const run = attempt();
    const projectTitle = `匯入目標專案 ${run}`;
    const collectionName = `匯入目標集合 ${run}`;
    const title = `指定去處的作品 ${run}`;
    await login(page);
    // Mutations need the app's own Origin (CSRF check).
    const headers = { origin: new URL(page.url()).origin };
    expect(
      (
        await page.request.post("/api/projects", { headers, data: { title: projectTitle } })
      ).status(),
    ).toBe(201);
    expect(
      (
        await page.request.post("/api/collections", { headers, data: { name: collectionName } })
      ).status(),
    ).toBe(201);

    await page.goto("/import");
    await page.getByTestId("import-project").selectOption({ label: projectTitle });
    await page.getByTestId("import-collection").selectOption({ label: collectionName });
    await page.getByTestId("import-file-input").setInputFiles([
      {
        name: `target-${run}.html`,
        mimeType: "text/html",
        buffer: Buffer.from(htmlDocument({ title, body: "<p>放進指定的專案與集合。</p>" })),
      },
    ]);
    await page.getByRole("button", { name: "開始上傳" }).click();
    await expect(page.getByTestId("import-summary")).toHaveText(/1 完成/, { timeout: 30_000 });
    // Once the batch exists its options are fixed: they apply to every file in it.
    await expect(page.getByTestId("import-project")).toBeDisabled();
    await expect(page.getByTestId("import-collection")).toBeDisabled();

    await page.goto("/projects");
    await page.getByRole("link", { name: projectTitle }).click();
    await expect(page.getByRole("heading", { name: title })).toBeVisible();
    await page.goto("/collections");
    await page.getByRole("link", { name: collectionName }).click();
    await expect(page.getByRole("heading", { name: title })).toBeVisible();
  });
});
