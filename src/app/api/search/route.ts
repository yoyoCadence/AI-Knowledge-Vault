import { z } from "zod";
import { searchArtifacts } from "@/modules/search";
import { json, parseQuery } from "../_lib/http";
import { authedRoute } from "../_lib/route";
import { services } from "../_lib/services";

const SearchQuery = z.object({
  q: z.string().trim().min(1).max(200),
  offset: z.coerce.number().int().min(0).max(1_000).default(0),
});

/**
 * GET /api/search?q=&offset= — keyword search over the actor's workspace (FR-SRCH-1..3,
 * docs/SEARCH_DESIGN.md). Snippets are plain `{text, highlight}` segments.
 */
export const GET = authedRoute({ permission: "library:read" }, async ({ request, actor }) => {
  const { q, offset } = parseQuery(request, SearchQuery);
  const { items, nextOffset } = await searchArtifacts(services.db(), actor, { q, offset });
  return json({ items, nextOffset });
});
