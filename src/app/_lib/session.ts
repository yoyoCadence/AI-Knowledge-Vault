import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { getActor, type Actor } from "@/modules/auth";

/** Current actor for Server Components, de-duplicated per request. */
export const getCurrentActor = cache(async (): Promise<Actor | null> => getActor(await headers()));

/** For protected pages: redirects anonymous visitors to /login. */
export async function requirePageActor(): Promise<Actor> {
  const actor = await getCurrentActor();
  if (!actor) redirect("/login");
  return actor;
}
