import { Trash2 } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requirePageActor } from "@/app/_lib/session";
import { RestoreDeleted } from "@/components/artifacts/artifact-delete";
import { label } from "@/components/library/artifact-card";
import { KindIcon } from "@/components/library/kind-icon";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/states";
import { getDb } from "@/infrastructure/database/client";
import { decodeCursorOrFirstPage, encodeCursor } from "@/lib/cursor";
import { formatDateTime } from "@/lib/format";
import { t } from "@/lib/i18n";
import { firstParam, type PageSearchParams } from "@/lib/search-params";
import { listDeletedArtifacts } from "@/modules/artifacts";
import { roleAllows } from "@/modules/auth";

export const metadata: Metadata = { title: t("deleted.title") };

const PAGE_SIZE = 50;

/**
 * The workspace's deleted artifacts (ADR-017), most recently deleted first, each with a button
 * that restores it. Only members who may edit the library see it: deleted artifacts are hidden
 * from everyone else, as everywhere.
 */
export default async function DeletedArtifactsPage({
  searchParams,
}: {
  searchParams: Promise<PageSearchParams>;
}) {
  const actor = await requirePageActor();
  if (!roleAllows(actor.role, "library:write")) notFound();
  const cursor = firstParam((await searchParams).cursor);
  const { items, nextCursor } = await listDeletedArtifacts(getDb(), actor, {
    limit: PAGE_SIZE,
    cursor: decodeCursorOrFirstPage(cursor),
  });

  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">{t("deleted.title")}</h1>
        <p className="text-muted-foreground mt-1 text-sm">{t("deleted.description")}</p>
      </header>
      {items.length === 0 ? (
        <EmptyState icon={Trash2} title={t("deleted.empty")} />
      ) : (
        <ul className="divide-border flex flex-col divide-y" data-testid="deleted-list">
          {items.map((item) => (
            <li
              key={item.id}
              className="flex flex-wrap items-center gap-x-3 gap-y-2 py-3"
              data-testid="deleted-item"
            >
              <KindIcon
                kind={item.contentKind ?? ""}
                className="text-muted-foreground size-4 shrink-0"
              />
              <span className="flex min-w-0 flex-1 basis-48 flex-col">
                <span className="font-medium break-words">{item.title}</span>
                <span className="text-muted-foreground text-xs">
                  {item.contentKind ? `${label("kind", item.contentKind)} · ` : null}
                  {t("deleted.at", { date: formatDateTime(item.deletedAt) })}
                </span>
              </span>
              <RestoreDeleted
                artifactId={item.id}
                then="stay"
                label={`${t("deleted.restore")}「${item.title}」`}
              />
            </li>
          ))}
        </ul>
      )}
      {nextCursor ? (
        <div className="flex justify-center">
          <Button asChild variant="outline">
            <Link
              href={`/settings/deleted?cursor=${encodeURIComponent(encodeCursor(nextCursor)!)}`}
            >
              {t("library.loadMore")}
            </Link>
          </Button>
        </div>
      ) : null}
    </div>
  );
}
