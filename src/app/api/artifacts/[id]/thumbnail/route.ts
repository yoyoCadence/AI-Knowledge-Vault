import { Readable } from "node:stream";
import { notFound } from "@/lib/errors";
import { isUuid } from "@/lib/ids";
import { getThumbnailForActor } from "@/modules/artifacts";
import { authedRoute } from "../../../_lib/route";
import { services } from "../../../_lib/services";

/** GET /api/artifacts/:id/thumbnail — the current version's generated WebP thumbnail. */
export const GET = authedRoute<{ id: string }>(
  { permission: "library:read" },
  async ({ request, actor, params }) => {
    if (!isUuid(params.id)) throw notFound("Thumbnail");
    const thumbnail = await getThumbnailForActor(services.db(), actor, params.id);
    const etag = `"${thumbnail.sha256}"`;
    if (request.headers.get("if-none-match") === etag)
      return new Response(null, {
        status: 304,
        headers: { etag, "cache-control": "private, no-cache" },
      });
    const { body, info } = await services.storage().getObject(thumbnail.storageKey);
    return new Response(Readable.toWeb(body) as ReadableStream<Uint8Array>, {
      headers: {
        "content-type": thumbnail.mimeType,
        "content-length": String(info.size),
        // Revalidate every time (cheap 304 via the ETag): the URL is keyed by artifact, so a
        // new version, a deletion or a logout must never keep serving a cached image.
        "cache-control": "private, no-cache",
        "x-content-type-options": "nosniff",
        etag,
      },
    });
  },
);
