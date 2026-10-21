import { z } from "zod";
import { notFound } from "@/lib/errors";
import { isUuid } from "@/lib/ids";
import { deleteTag, renameTag } from "@/modules/tags";
import { json, parseJsonBody } from "../../_lib/http";
import { authedRoute } from "../../_lib/route";
import { services } from "../../_lib/services";

const RenameTag = z.object({ name: z.string().max(200) });

/** PATCH /api/tags/:id `{name}` — rename; 409 CONFLICT when another tag has the name. */
export const PATCH = authedRoute<{ id: string }>(
  { permission: "library:write" },
  async ({ request, actor, params, meta }) => {
    if (!isUuid(params.id)) throw notFound("Tag");
    const { name } = await parseJsonBody(request, RenameTag);
    return json({ tag: await renameTag(services.db(), actor, params.id, name, meta) });
  },
);

/** DELETE /api/tags/:id — delete the tag and remove it from every artifact. */
export const DELETE = authedRoute<{ id: string }>(
  { permission: "library:write" },
  async ({ actor, params, meta }) => {
    if (!isUuid(params.id)) throw notFound("Tag");
    await deleteTag(services.db(), actor, params.id, meta);
    return json({ deleted: true });
  },
);
