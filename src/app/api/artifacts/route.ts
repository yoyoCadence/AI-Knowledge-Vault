import { z } from "zod";
import { LIBRARY_SORTS, listArtifacts } from "@/modules/artifacts";
import { decodeCursor, encodeCursor } from "@/lib/cursor";
import { FilterParams, toFilters } from "../_lib/filters";
import { json, parseQuery } from "../_lib/http";
import { authedRoute } from "../_lib/route";
import { services } from "../_lib/services";

const Query = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(24),
  cursor: z.string().max(200).optional(),
  sort: z.enum(LIBRARY_SORTS).default("newest"),
  ...FilterParams,
});

/**
 * GET /api/artifacts — library cards (with tags), newest or oldest first, cursor-paginated,
 * filtered by `tag`, `project`, `kind`, `model` (source model), `from`/`to` (YYYY-MM-DD).
 */
export const GET = authedRoute({ permission: "library:read" }, async ({ request, actor }) => {
  const query = parseQuery(request, Query);
  const { items, nextCursor } = await listArtifacts(services.db(), actor, {
    limit: query.limit,
    cursor: decodeCursor(query.cursor),
    filters: toFilters(query),
    sort: query.sort,
  });
  return json({ items, nextCursor: encodeCursor(nextCursor) });
});
