import { z } from "zod";
import { notFound } from "@/lib/errors";
import { isUuid } from "@/lib/ids";
import { deleteNote, updateNote } from "@/modules/notes";
import { json, parseJsonBody } from "../../_lib/http";
import { authedRoute } from "../../_lib/route";
import { services } from "../../_lib/services";

const UpdateNote = z.object({ bodyMarkdown: z.string().max(100_000) }).strict();

/** PATCH /api/notes/:id `{bodyMarkdown}` — replace the note's text; returns `{note}`. */
export const PATCH = authedRoute<{ id: string }>(
  { permission: "library:write" },
  async ({ request, actor, params, meta }) => {
    if (!isUuid(params.id)) throw notFound("Note");
    const { bodyMarkdown } = await parseJsonBody(request, UpdateNote);
    return json({ note: await updateNote(services.db(), actor, params.id, bodyMarkdown, meta) });
  },
);

/** DELETE /api/notes/:id — `{deleted: true}`. */
export const DELETE = authedRoute<{ id: string }>(
  { permission: "library:write" },
  async ({ actor, params, meta }) => {
    if (!isUuid(params.id)) throw notFound("Note");
    await deleteNote(services.db(), actor, params.id, meta);
    return json({ deleted: true });
  },
);
