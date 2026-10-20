import {
  createBatch,
  auditBatchCreated,
  CreateBatchInput,
  listBatches,
  toBatchDto,
} from "@/modules/imports";
import { json, parseJsonBody } from "../_lib/http";
import { authedRoute } from "../_lib/route";
import { services } from "../_lib/services";

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

/** GET /api/imports — recent batches with counts. */
export const GET = authedRoute({ permission: "library:read" }, async ({ actor }) => {
  return json({ items: await listBatches(services.db(), actor) });
});
