import { z } from "zod";
import { notFound } from "@/lib/errors";
import { isUuid } from "@/lib/ids";
import { createNote, listNotes } from "@/modules/notes";
import { json, parseJsonBody } from "../../../_lib/http";
import { authedRoute } from "../../../_lib/route";
import { services } from "../../../_lib/services";

const CreateNote = z.object({ bodyMarkdown: z.string().max(100_000) }).strict();

/** GET /api/artifacts/:id/notes — the artifact's notes, newest first. */
export const GET = authedRoute<{ id: string }>(
  { permission: "library:read" },
  async ({ actor, params }) => {
    if (!isUuid(params.id)) throw notFound("Artifact");
    return json({ items: await listNotes(services.db(), actor, params.id) });
  },
);

/**
 * POST /api/artifacts/:id/notes `{bodyMarkdown}` — 201 with the note. Markdown of 1–20,000
 * characters; it is shown through the reading mode's allow-list renderer, never as HTML.
 */
export const POST = authedRoute<{ id: string }>(
  { permission: "library:write" },
  async ({ request, actor, params, meta }) => {
    if (!isUuid(params.id)) throw notFound("Artifact");
    const { bodyMarkdown } = await parseJsonBody(request, CreateNote);
    const note = await createNote(services.db(), actor, params.id, bodyMarkdown, meta);
    return json({ note }, { status: 201 });
  },
);
