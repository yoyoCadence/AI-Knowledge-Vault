import type { Metadata } from "next";
import { requirePageActor } from "@/app/_lib/session";
import { CollectionManager } from "@/components/collections/collection-manager";
import { getDb } from "@/infrastructure/database/client";
import { t } from "@/lib/i18n";
import { roleAllows } from "@/modules/auth";
import { listCollections } from "@/modules/collections";

export const metadata: Metadata = { title: t("nav.collections") };

export default async function CollectionsPage() {
  const actor = await requirePageActor();
  const collections = await listCollections(getDb(), actor);
  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">{t("collections.title")}</h1>
        <p className="text-muted-foreground mt-1 text-sm">{t("collections.description")}</p>
      </header>
      <CollectionManager
        collections={collections.map((row) => ({
          id: row.id,
          parentId: row.parentId,
          kind: row.kind,
          name: row.name,
          description: row.description,
          artifactCount: row.artifactCount,
          depth: row.depth,
        }))}
        canEdit={roleAllows(actor.role, "library:write")}
      />
    </div>
  );
}
