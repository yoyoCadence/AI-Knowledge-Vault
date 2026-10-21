import { z } from "zod";
import { COLLECTION_KINDS } from "@/infrastructure/database/schema";
import { notFound } from "@/lib/errors";
import { isUuid } from "@/lib/ids";
import { deleteCollection, updateCollection } from "@/modules/collections";
import { json, parseJsonBody } from "../../_lib/http";
import { authedRoute } from "../../_lib/route";
import { services } from "../../_lib/services";

const UpdateCollection = z
  .object({
    name: z.string().max(1_000).optional(),
    parentId: z.uuid().nullable().optional(),
    kind: z.enum(COLLECTION_KINDS).optional(),
    description: z.string().max(10_000).nullable().optional(),
  })
  .strict();

/**
 * PATCH /api/collections/:id `{name?, parentId?, kind?, description?}` — rename, re-kind,
 * describe or move (`parentId: null` moves it to the top). A move into its own subtree or one
 * that nests too deep is 400; a sibling with the same name is 409.
 */
export const PATCH = authedRoute<{ id: string }>(
  { permission: "library:write" },
  async ({ request, actor, params, meta }) => {
    if (!isUuid(params.id)) throw notFound("Collection");
    const input = await parseJsonBody(request, UpdateCollection);
    return json({
      collection: await updateCollection(services.db(), actor, params.id, input, meta),
    });
  },
);

/**
 * DELETE /api/collections/:id — delete a collection without subcollections (409 with
 * `details.reason: HAS_CHILDREN` otherwise). Its artifacts stay in the library.
 */
export const DELETE = authedRoute<{ id: string }>(
  { permission: "library:write" },
  async ({ actor, params, meta }) => {
    if (!isUuid(params.id)) throw notFound("Collection");
    await deleteCollection(services.db(), actor, params.id, meta);
    return json({ deleted: true });
  },
);
