import type { Metadata } from "next";
import { requirePageActor } from "@/app/_lib/session";
import { SessionsPanel } from "@/components/settings/sessions-panel";
import { getDb } from "@/infrastructure/database/client";
import { t } from "@/lib/i18n";
import { listActiveSessions } from "@/modules/auth";

export const metadata: Metadata = { title: t("nav.settings") };

export default async function SettingsPage() {
  const actor = await requirePageActor();
  const sessions = await listActiveSessions(getDb(), actor);

  return (
    <div className="flex max-w-3xl flex-col gap-8">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">{t("settings.title")}</h1>
      </header>
      <section className="flex flex-col gap-3" aria-labelledby="sessions-heading">
        <div>
          <h2 id="sessions-heading" className="text-base font-semibold">
            {t("sessions.title")}
          </h2>
          <p className="text-muted-foreground mt-1 text-sm">{t("sessions.description")}</p>
        </div>
        <SessionsPanel
          sessions={sessions.map((session) => ({
            ...session,
            createdAt: session.createdAt.toISOString(),
            expiresAt: session.expiresAt.toISOString(),
          }))}
        />
      </section>
    </div>
  );
}
