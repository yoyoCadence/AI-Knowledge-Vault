import { z } from "zod";
import { SEARCH_SORTS, searchArtifacts } from "@/modules/search";
import { FilterParams, toFilters } from "../_lib/filters";
import { json, parseQuery } from "../_lib/http";
import { authedRoute } from "../_lib/route";
import { services } from "../_lib/services";

const SearchQuery = z.object({
  q: z.string().trim().min(1).max(200),
  offset: z.coerce.number().int().min(0).max(1_000).default(0),
  sort: z.enum(SEARCH_SORTS).default("relevance"),
  ...FilterParams,
});

/**
 * GET /api/search?q=&offset=&sort=&tag=&project=&kind=&model=&from=&to= — keyword search over
 * the actor's workspace (FR-SRCH-1..3, docs/SEARCH_DESIGN.md), with the library filters and
 * `total`. Snippets are plain `{text, highlight}` segments.
 */
export const GET = authedRoute({ permission: "library:read" }, async ({ request, actor }) => {
  const query = parseQuery(request, SearchQuery);
  const { items, nextOffset, total } = await searchArtifacts(services.db(), actor, {
    q: query.q,
    offset: query.offset,
    sort: query.sort,
    filters: toFilters(query),
  });
  return json({ items, nextOffset, total });
});
