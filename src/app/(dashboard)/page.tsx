import { Library, Upload } from "lucide-react";
import Link from "next/link";
import { requirePageActor } from "@/app/_lib/session";
import { ArtifactCard } from "@/components/library/artifact-card";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/states";
import { getDb } from "@/infrastructure/database/client";
import { t } from "@/lib/i18n";
import { listArtifacts } from "@/modules/artifacts";

const PAGE_SIZE = 48;

function decodeCursor(value: string | undefined) {
  if (!value) return undefined;
  try {
    const [createdAt, id] = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as [
      string,
      string,
    ];
    return { createdAt: new Date(createdAt), id };
  } catch {
    return undefined;
  }
}

export default async function LibraryPage({
  searchParams,
}: {
  searchParams: Promise<{ cursor?: string }>;
}) {
  const actor = await requirePageActor();
  const { cursor } = await searchParams;
  const { items, nextCursor } = await listArtifacts(getDb(), actor, {
    limit: PAGE_SIZE,
    cursor: decodeCursor(cursor),
  });

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{t("library.title")}</h1>
          <p className="text-muted-foreground mt-1 text-sm">{t("app.tagline")}</p>
        </div>
        <Button asChild>
          <Link href="/import">
            <Upload />
            {t("library.import")}
          </Link>
        </Button>
      </header>

      {items.length === 0 && !cursor ? (
        <EmptyState
          icon={Library}
          title={t("library.empty.title")}
          description={t("library.empty.body")}
          action={
            <Button asChild variant="outline">
              <Link href="/import">{t("library.import")}</Link>
            </Button>
          }
        />
      ) : (
        <section
          aria-label={t("library.title")}
          className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4"
        >
          {items.map((item) => (
            <ArtifactCard
              key={item.id}
              artifact={{
                id: item.id,
                title: item.title,
                summary: item.summary,
                visibility: item.visibility,
                createdAt: item.createdAt.toISOString(),
                versionCount: item.versionCount,
                hasThumbnail: item.hasThumbnail,
                contentKind: item.currentVersion?.contentKind ?? null,
                sourcePlatform: item.currentVersion?.sourcePlatform ?? null,
                sourceModel: item.currentVersion?.sourceModel ?? null,
              }}
            />
          ))}
        </section>
      )}

      {nextCursor ? (
        <div className="flex justify-center">
          <Button asChild variant="outline">
            <Link
              href={`/?cursor=${Buffer.from(JSON.stringify([nextCursor.createdAt.toISOString(), nextCursor.id])).toString("base64url")}`}
            >
              {t("library.loadMore")}
            </Link>
          </Button>
        </div>
      ) : null}
    </div>
  );
}
