import { z } from "zod";
import { listArtifacts } from "@/modules/artifacts";
import { decodeCursor, encodeCursor } from "@/lib/cursor";
import { json, parseQuery } from "../_lib/http";
import { authedRoute } from "../_lib/route";
import { services } from "../_lib/services";

const Query = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(24),
  cursor: z.string().max(200).optional(),
  tag: z.uuid().optional(),
});

/** GET /api/artifacts?tag= — library cards (with tags), newest first, cursor-paginated. */
export const GET = authedRoute({ permission: "library:read" }, async ({ request, actor }) => {
  const query = parseQuery(request, Query);
  const { items, nextCursor } = await listArtifacts(services.db(), actor, {
    limit: query.limit,
    cursor: decodeCursor(query.cursor),
    tagId: query.tag,
  });
  return json({ items, nextCursor: encodeCursor(nextCursor) });
});
