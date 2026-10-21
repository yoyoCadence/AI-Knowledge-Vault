import { z } from "zod";
import { notFound } from "@/lib/errors";
import { isUuid } from "@/lib/ids";
import { mergeTag } from "@/modules/tags";
import { json, parseJsonBody } from "../../../_lib/http";
import { authedRoute } from "../../../_lib/route";
import { services } from "../../../_lib/services";

const MergeTag = z.object({ intoTagId: z.uuid() });

/** POST /api/tags/:id/merge `{intoTagId}` — move this tag's artifacts to another tag, delete it. */
export const POST = authedRoute<{ id: string }>(
  { permission: "library:write" },
  async ({ request, actor, params, meta }) => {
    if (!isUuid(params.id)) throw notFound("Tag");
    const { intoTagId } = await parseJsonBody(request, MergeTag);
    return json({ tag: await mergeTag(services.db(), actor, params.id, intoTagId, meta) });
  },
);
