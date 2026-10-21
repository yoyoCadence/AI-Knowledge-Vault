import { z } from "zod";
import { READING_STATUSES } from "@/infrastructure/database/schema";
import { notFound } from "@/lib/errors";
import { isUuid } from "@/lib/ids";
import { getArtifactForActor } from "@/modules/artifacts";
import { readingStateOf, setReadingState } from "@/modules/notes";
import { json, parseJsonBody } from "../../../_lib/http";
import { authedRoute } from "../../../_lib/route";
import { services } from "../../../_lib/services";

const UpdateState = z
  .object({
    status: z.enum(READING_STATUSES).optional(),
    isFavorite: z.boolean().optional(),
    opened: z.literal(true).optional(),
  })
  .strict();

/** GET /api/artifacts/:id/reading-state — the actor's own `{status, isFavorite, lastOpenedAt}`. */
export const GET = authedRoute<{ id: string }>(
  { permission: "library:read" },
  async ({ actor, params }) => {
    if (!isUuid(params.id)) throw notFound("Artifact");
    await getArtifactForActor(services.db(), actor, params.id);
    return json({ readingState: await readingStateOf(services.db(), actor, params.id) });
  },
);

/**
 * PUT /api/artifacts/:id/reading-state `{status?, isFavorite?, opened?: true}` — change the
 * actor's own reading state. `opened` records that they opened it now and moves an unread
 * artifact to "reading". Personal state, so readers (viewers) may set it too.
 */
export const PUT = authedRoute<{ id: string }>(
  { permission: "library:read" },
  async ({ request, actor, params }) => {
    if (!isUuid(params.id)) throw notFound("Artifact");
    const input = await parseJsonBody(request, UpdateState);
    return json({ readingState: await setReadingState(services.db(), actor, params.id, input) });
  },
);
