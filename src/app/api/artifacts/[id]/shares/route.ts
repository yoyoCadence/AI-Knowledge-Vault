import { z } from "zod";
import { notFound } from "@/lib/errors";
import { isUuid } from "@/lib/ids";
import { createShare, listShares } from "@/modules/sharing";
import { json, parseJsonBody } from "../../../_lib/http";
import { authedRoute } from "../../../_lib/route";
import { services } from "../../../_lib/services";

const CreateShare = z
  .object({
    label: z.string().max(1_000).nullish(),
    allowPreview: z.boolean(),
    allowReading: z.boolean(),
    allowDownload: z.boolean(),
    expiresAt: z.iso.datetime({ offset: true }).nullish(),
    // The client showed the pre-share check and the owner confirmed it.
    acknowledgeFindings: z.literal(true),
  })
  .strict();

/** GET /api/artifacts/:id/shares — the artifact's links, newest first; tokens are not stored. */
export const GET = authedRoute<{ id: string }>(
  { permission: "share:manage" },
  async ({ actor, params }) => {
    if (!isUuid(params.id)) throw notFound("Artifact");
    return json({ items: await listShares(services.db(), actor, params.id) });
  },
);

/**
 * POST /api/artifacts/:id/shares — 201 `{share, url, madeUnlisted}`. The URL holds the token and
 * is returned only here, once. A private artifact becomes unlisted; restricted ones are 409.
 */
export const POST = authedRoute<{ id: string }>(
  { permission: "share:manage" },
  async ({ request, actor, params, meta }) => {
    if (!isUuid(params.id)) throw notFound("Artifact");
    const body = await parseJsonBody(request, CreateShare);
    const { share, token, madeUnlisted } = await createShare(
      services.db(),
      actor,
      params.id,
      {
        label: body.label ?? null,
        allowPreview: body.allowPreview,
        allowReading: body.allowReading,
        allowDownload: body.allowDownload,
        expiresAt: body.expiresAt ? new Date(body.expiresAt) : null,
      },
      meta,
    );
    return json(
      { share, url: `${services.env().APP_ORIGIN}/s/${token}`, madeUnlisted },
      { status: 201 },
    );
  },
);
