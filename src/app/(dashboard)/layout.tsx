import type { ReactNode } from "react";
import { requirePageActor } from "@/app/_lib/session";
import { UserMenu } from "@/components/auth/user-menu";
import { AppShell } from "@/components/layout/app-shell";

/** Every dashboard page requires an authenticated actor (FR-AUTH-5). */
export default async function DashboardLayout({ children }: { children: ReactNode }) {
  const actor = await requirePageActor();
  return <AppShell userSlot={<UserMenu email={actor.email} />}>{children}</AppShell>;
}
