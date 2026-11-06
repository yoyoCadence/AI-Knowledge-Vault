import { t } from "@/lib/i18n";

/**
 * Browser-side request plumbing shared by the app's client components. Two failures need words
 * of our own, because what the platform gives is not fit to show:
 *
 * - No answer came back (offline, connection dropped, DNS): `fetch` rejects with the browser's
 *   own text, "Failed to fetch" or "Load failed", in English. The request may still have
 *   reached the server and been carried out (only the answer was lost), so the message says
 *   the outcome is unknown and asks to check before retrying: not every request is idempotent.
 * - The session ended (`401`): "try again" would never work; the user has to sign in again.
 */

/** `fetch`, but a request that never got an answer throws an Error ready to show the user. */
export async function fetchOrExplain(input: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(input, init);
  } catch {
    throw new Error(t("request.error.network"));
  }
}

/** The message for a response that means the session is gone, or null for any other. */
export function signedOutMessage(response: Response): string | null {
  return response.status === 401 ? t("request.error.signedOut") : null;
}
