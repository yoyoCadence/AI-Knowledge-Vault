import { z } from "zod";
import { COLLECTION_KINDS } from "@/infrastructure/database/schema";
import { createCollection, listCollections } from "@/modules/collections";
import { json, parseJsonBody } from "../_lib/http";
import { authedRoute } from "../_lib/route";
import { services } from "../_lib/services";

const CreateCollection = z
  .object({
    name: z.string().max(1_000),
    parentId: z.uuid().nullable().optional(),
    kind: z.enum(COLLECTION_KINDS).optional(),
    description: z.string().max(10_000).nullable().optional(),
  })
  .strict();

/**
 * GET /api/collections — the workspace's collection tree, depth-first (siblings by name), each
 * node with `parentId`, `depth` and the number of artifacts directly in it.
 */
export const GET = authedRoute({ permission: "library:read" }, async ({ actor }) => {
  return json({ items: await listCollections(services.db(), actor) });
});

/**
 * POST /api/collections `{name, parentId?, kind?, description?}` — 201 with the collection;
 * 409 CONFLICT when a sibling already has the name; 404 for an unknown parent.
 */
export const POST = authedRoute(
  { permission: "library:write" },
  async ({ request, actor, meta }) => {
    const input = await parseJsonBody(request, CreateCollection);
    const collection = await createCollection(services.db(), actor, input, meta);
    return json({ collection }, { status: 201 });
  },
);
