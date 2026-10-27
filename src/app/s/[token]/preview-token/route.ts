import { getEnv } from "@/infrastructure/config/env";
import { getDb } from "@/infrastructure/database/client";
import { issueSharePreviewUrl, shareVersion } from "@/modules/sharing";
import { refusal, SHARE_RESPONSE_HEADERS, shareRoute } from "../../_lib/access";

/**
 * POST /s/:token/preview-token — a fresh preview URL for the link's holder (the shared page's
 * frame refreshes through this). It changes nothing, so it needs no CSRF check: the token in the
 * path is the whole authority, and it is the same one the page was opened with.
 */
export const POST = shareRoute(async ({ capability }) => {
  const version = await shareVersion(getDb(), capability);
  const preview = version
    ? await issueSharePreviewUrl(getDb(), capability, version, getEnv())
    : null;
  if (!preview) return refusal("not_found");
  return new Response(
    JSON.stringify({
      url: preview.url,
      expiresAt: preview.expiresAt.toISOString(),
      expiresInSeconds: preview.expiresInSeconds,
    }),
    { headers: { ...SHARE_RESPONSE_HEADERS, "content-type": "application/json; charset=utf-8" } },
  );
});
