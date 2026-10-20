import { getDb } from "@/infrastructure/database/client";
import { revokeOtherSessions } from "@/modules/auth";
import { json } from "../../_lib/http";
import { authedRoute } from "../../_lib/route";

/** POST /api/sessions/revoke-others — sign out every other device (audited). */
export const POST = authedRoute({ permission: "library:read" }, async ({ actor, meta }) => {
  const count = await revokeOtherSessions(getDb(), actor, meta);
  return json({ revoked: count });
});
