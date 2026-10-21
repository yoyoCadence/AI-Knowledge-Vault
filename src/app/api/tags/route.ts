import { z } from "zod";
import { ensureTag, listTags } from "@/modules/tags";
import { json, parseJsonBody } from "../_lib/http";
import { authedRoute } from "../_lib/route";
import { services } from "../_lib/services";

const CreateTag = z.object({ name: z.string().max(200) });

/** GET /api/tags — the workspace's tags with artifact counts, by name. */
export const GET = authedRoute({ permission: "library:read" }, async ({ actor }) => {
  return json({ items: await listTags(services.db(), actor) });
});

/**
 * POST /api/tags `{name}` — the tag with this name, created if needed: 201 when created, 200
 * when a tag with the same normalized name already existed.
 */
export const POST = authedRoute(
  { permission: "library:write" },
  async ({ request, actor, meta }) => {
    const { name } = await parseJsonBody(request, CreateTag);
    const { tag, created } = await ensureTag(services.db(), actor, name, meta);
    return json({ tag }, { status: created ? 201 : 200 });
  },
);
