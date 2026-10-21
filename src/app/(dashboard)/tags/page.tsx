import { Tags } from "lucide-react";
import type { Metadata } from "next";
import { requirePageActor } from "@/app/_lib/session";
import { TagManager } from "@/components/tags/tag-manager";
import { EmptyState } from "@/components/ui/states";
import { getDb } from "@/infrastructure/database/client";
import { t } from "@/lib/i18n";
import { roleAllows } from "@/modules/auth";
import { listTags } from "@/modules/tags";

export const metadata: Metadata = { title: t("nav.tags") };

export default async function TagsPage() {
  const actor = await requirePageActor();
  const tags = await listTags(getDb(), actor);

  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">{t("tags.title")}</h1>
        <p className="text-muted-foreground mt-1 text-sm">{t("tags.description")}</p>
      </header>
      {tags.length === 0 ? (
        <EmptyState icon={Tags} title={t("tags.empty.title")} description={t("tags.empty.body")} />
      ) : (
        <TagManager tags={tags} canEdit={roleAllows(actor.role, "library:write")} />
      )}
    </div>
  );
}
