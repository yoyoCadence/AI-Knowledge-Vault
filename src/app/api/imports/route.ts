import { z } from "zod";
import {
  createBatch,
  auditBatchCreated,
  CreateBatchInput,
  listBatches,
  toBatchDto,
} from "@/modules/imports";
import { decodeCursor, encodeCursor } from "../_lib/cursor";
import { json, parseJsonBody, parseQuery } from "../_lib/http";
import { authedRoute } from "../_lib/route";
import { services } from "../_lib/services";

const Query = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().max(200).optional(),
});

/** POST /api/imports — create an import batch. */
export const POST = authedRoute(
  { permission: "import:create" },
  async ({ request, actor, meta }) => {
    const input = await parseJsonBody(request, CreateBatchInput);
    const batch = await createBatch(services.db(), actor, input);
    await auditBatchCreated(services.db(), actor, batch.id, meta);
    return json({ batch: toBatchDto(batch) }, { status: 201 });
  },
);

/** GET /api/imports — batches with counts, newest first, cursor-paginated. */
export const GET = authedRoute({ permission: "library:read" }, async ({ request, actor }) => {
  const query = parseQuery(request, Query);
  const { items, nextCursor } = await listBatches(services.db(), actor, {
    limit: query.limit,
    cursor: decodeCursor(query.cursor),
  });
  return json({ items, nextCursor: encodeCursor(nextCursor) });
});
