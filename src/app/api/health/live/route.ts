import { APP_VERSION } from "@/lib/version";
import { json } from "../../_lib/http";

export const dynamic = "force-dynamic";

/**
 * Liveness for the platform's health checks and uptime monitors: the web process answers.
 * It touches neither the database nor storage, so probing it every few seconds lets a database
 * that scales to zero sleep (ADR-024). `/api/health` checks both, for a person or a deploy step.
 */
export function GET(): Response {
  return json({ status: "ok", version: APP_VERSION });
}
