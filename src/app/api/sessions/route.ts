import { getDb } from "@/infrastructure/database/client";
import { listActiveSessions } from "@/modules/auth";
import { json } from "../_lib/http";
import { authedRoute } from "../_lib/route";

/** GET /api/sessions — the actor's active sessions (no tokens). */
export const GET = authedRoute({ permission: "library:read" }, async ({ actor }) => {
  const items = await listActiveSessions(getDb(), actor);
  return json({ items });
});
