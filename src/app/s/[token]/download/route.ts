import { getDb } from "@/infrastructure/database/client";
import { getStorage } from "@/infrastructure/storage";
import { createSharedDownload } from "@/modules/sharing";
import { requestMeta } from "../../../api/_lib/http";
import { refusal, SHARE_RESPONSE_HEADERS, shareRoute } from "../../_lib/access";

/**
 * GET /s/:token/download — 302 to a 5-minute signed URL for the original, when the link allows
 * downloads (404 otherwise, like any other refusal). Audited with the link's id.
 */
export const GET = shareRoute(async ({ request, capability }) => {
  const download = await createSharedDownload(
    getDb(),
    getStorage(),
    capability,
    requestMeta(request),
  );
  if (!download) return refusal("not_found");
  return new Response(null, {
    status: 302,
    headers: {
      ...SHARE_RESPONSE_HEADERS,
      location: download.url,
      "x-content-sha256": download.sha256,
    },
  });
});
