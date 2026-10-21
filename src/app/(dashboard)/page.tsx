import { Library, Search, Upload } from "lucide-react";
import Link from "next/link";
import { requirePageActor } from "@/app/_lib/session";
import { ArtifactCard } from "@/components/library/artifact-card";
import { SearchResults } from "@/components/library/search-results";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/states";
import { getDb } from "@/infrastructure/database/client";
import { decodeCursorOrFirstPage, encodeCursor } from "@/lib/cursor";
import { t } from "@/lib/i18n";
import { firstParam, searchQueryParam, type PageSearchParams } from "@/lib/search-params";
import { listArtifacts } from "@/modules/artifacts";
import { searchArtifacts } from "@/modules/search";

const PAGE_SIZE = 48;

function SearchForm({ q }: { q: string }) {
  // A plain GET form: search works without client JavaScript and the URL is shareable.
  return (
    <form action="/" method="get" role="search" className="flex w-full max-w-xl gap-2">
      <label className="sr-only" htmlFor="library-search">
        {t("search.label")}
      </label>
      <input
        id="library-search"
        name="q"
        type="search"
        defaultValue={q}
        maxLength={200}
        placeholder={t("search.placeholder")}
        className="border-border-strong bg-surface focus-visible:ring-ring h-9 min-w-0 flex-1 rounded-md border px-3 text-sm focus-visible:ring-2 focus-visible:outline-none"
      />
      <Button type="submit" variant="outline">
        <Search />
        {t("search.submit")}
      </Button>
    </form>
  );
}

async function SearchView({ q, offset }: { q: string; offset: number }) {
  const actor = await requirePageActor();
  const { items, nextOffset, terms } = await searchArtifacts(getDb(), actor, { q, offset });
  return (
    <section aria-label={t("search.results", { q })} className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-semibold">{t("search.results", { q })}</h2>
        <Link href="/" className="text-muted-foreground hover:text-foreground text-sm">
          {t("search.clear")}
        </Link>
      </div>
      {terms.length === 0 ? (
        <p className="text-muted-foreground text-sm">{t("search.invalid")}</p>
      ) : items.length === 0 ? (
        <p className="text-muted-foreground text-sm" data-testid="search-none">
          {t("search.none", { q })}
        </p>
      ) : (
        <SearchResults items={items} />
      )}
      {nextOffset !== null ? (
        <div className="flex justify-center">
          <Button asChild variant="outline">
            <Link href={`/?q=${encodeURIComponent(q)}&offset=${nextOffset}`}>
              {t("library.loadMore")}
            </Link>
          </Button>
        </div>
      ) : null}
    </section>
  );
}

export default async function LibraryPage({
  searchParams,
}: {
  searchParams: Promise<PageSearchParams>;
}) {
  const actor = await requirePageActor();
  const params = await searchParams;
  const cursor = firstParam(params.cursor);
  const offset = firstParam(params.offset);
  const q = searchQueryParam(params.q);
  if (q) {
    return (
      <div className="flex flex-col gap-6">
        <header className="flex flex-col gap-4">
          <h1 className="text-2xl font-semibold tracking-tight">{t("library.title")}</h1>
          <SearchForm q={q} />
        </header>
        <SearchView q={q} offset={Math.max(0, Number.parseInt(offset ?? "0", 10) || 0)} />
      </div>
    );
  }
  const { items, nextCursor } = await listArtifacts(getDb(), actor, {
    limit: PAGE_SIZE,
    cursor: decodeCursorOrFirstPage(cursor),
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
        <SearchForm q="" />
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
            <Link href={`/?cursor=${encodeCursor(nextCursor)}`}>{t("library.loadMore")}</Link>
          </Button>
        </div>
      ) : null}
    </div>
  );
}
