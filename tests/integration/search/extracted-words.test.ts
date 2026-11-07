import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { closeDb } from "@/infrastructure/database/client";
import { importItems } from "@/infrastructure/database/schema";
import type { Actor } from "@/modules/auth";
import { searchArtifacts } from "@/modules/search";
import { closeTestDb, testDb } from "../helpers/db";
import { createTestActor, drainJobs, newBatch, uploadFile } from "../helpers/imports";

/**
 * What extraction keeps (HTML extractor 2, Markdown extractor 2) is what search finds: the text
 * of a page wrapped in a form, an accordion's collapsed answers, and words a line break, a
 * dropped control or an inline-styled box used to join.
 */

const db = testDb();

afterAll(async () => {
  await closeDb();
  await closeTestDb();
});

async function importFile(actor: Actor, filename: string, text: string) {
  const item = await uploadFile(actor, (await newBatch(actor)).id, {
    filename,
    bytes: Buffer.from(text),
  });
  await drainJobs();
  const [row] = await db
    .select({ status: importItems.status })
    .from(importItems)
    .where(eq(importItems.id, item.id));
  return row?.status;
}

const titles = async (actor: Actor, q: string) =>
  (await searchArtifacts(db, actor, { q })).items.map((item) => item.title).sort();

describe("search finds what extraction now keeps", () => {
  it("finds a form-wrapped page, an accordion's answers and words that used to be joined", async () => {
    const actor = await createTestActor();
    expect(
      await importFile(
        actor,
        "webforms.html",
        `<!doctype html><html lang="zh-Hant-TW"><head><title>補助公告</title></head><body>
<form id="form1" method="post" action="./news.aspx"><input type="hidden" name="__VIEWSTATE" value="x">
<h1>補助公告</h1><p>本府公布新版透水鋪面補助辦法。</p>
<h3><button aria-expanded="false" aria-controls="a1">Eligibility</button></h3>
<div id="a1" hidden><p>Residents registered for one year.</p></div>
<p>Pavement<br>permeability<button>Copy</button>coefficient</p>
<div style="display:flex"><span>Albedo</span><span>Emissivity</span></div>
</form></body></html>`,
      ),
    ).toBe("succeeded");
    expect(
      await importFile(actor, "notes.md", "# Field notes\n\nCanopy  \ncooling <kbd>shade</kbd>\n"),
    ).toBe("succeeded");

    for (const q of ["透水鋪面", "Eligibility", "registered", "permeability", "coefficient"]) {
      expect(await titles(actor, q), q).toEqual(["補助公告"]);
    }
    expect(await titles(actor, "Emissivity")).toEqual(["補助公告"]);
    expect(await titles(actor, "cooling")).toEqual(["Field notes"]);
    // Markup is not text: no document is found by a tag name.
    expect(await titles(actor, "kbd")).toEqual([]);
    expect(await titles(actor, "Copy")).toEqual([]);
  });
});
