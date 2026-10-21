import { Library, Search, Tag, Upload, X } from "lucide-react";
import Link from "next/link";
import { requirePageActor } from "@/app/_lib/session";
import { ArtifactCard } from "@/components/library/artifact-card";
import { SearchResults } from "@/components/library/search-results";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/states";
import { getDb } from "@/infrastructure/database/client";
import { decodeCursorOrFirstPage, encodeCursor } from "@/lib/cursor";
import { t } from "@/lib/i18n";
import { isUuid } from "@/lib/ids";
import { firstParam, searchQueryParam, type PageSearchParams } from "@/lib/search-params";
import { listArtifacts } from "@/modules/artifacts";
import { searchArtifacts } from "@/modules/search";
import { findTag, type TagSummary } from "@/modules/tags";

const PAGE_SIZE = 48;

/** `/` with the given parameters, skipping empty ones. */
function libraryHref(params: Record<string, string | number | null | undefined>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== null && value !== undefined && value !== "") query.set(key, String(value));
  }
  const text = query.toString();
  return text ? `/?${text}` : "/";
}

function SearchForm({ q, tag }: { q: string; tag: TagSummary | null }) {
  // A plain GET form: search works without client JavaScript and the URL is shareable.
  return (
    <form action="/" method="get" role="search" className="flex w-full max-w-xl gap-2">
      {tag ? <input type="hidden" name="tag" value={tag.id} /> : null}
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

/** The active tag filter, with a link that removes it (and keeps the search). */
function TagFilter({ tag, q }: { tag: TagSummary; q: string }) {
  return (
    <p className="flex flex-wrap items-center gap-2 text-sm" data-testid="tag-filter">
      <Tag className="text-muted-foreground size-4" aria-hidden />
      {t("tags.filtered", { name: tag.name })}
      <Link
        href={libraryHref({ q })}
        className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
      >
        <X className="size-3.5" aria-hidden />
        {t("tags.clearFilter")}
      </Link>
    </p>
  );
}

async function SearchView({
  q,
  offset,
  tag,
}: {
  q: string;
  offset: number;
  tag: TagSummary | null;
}) {
  const actor = await requirePageActor();
  const { items, nextOffset, terms } = await searchArtifacts(getDb(), actor, {
    q,
    offset,
    tagId: tag?.id,
  });
  return (
    <section aria-label={t("search.results", { q })} className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-semibold">{t("search.results", { q })}</h2>
        <Link
          href={libraryHref({ tag: tag?.id })}
          className="text-muted-foreground hover:text-foreground text-sm"
        >
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
            <Link href={libraryHref({ q, tag: tag?.id, offset: nextOffset })}>
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
  const tagParam = firstParam(params.tag);
  // Another workspace's tag is indistinguishable from a missing one.
  const tag = tagParam && isUuid(tagParam) ? await findTag(getDb(), actor, tagParam) : null;
  if (tagParam && !tag) {
    return (
      <EmptyState
        icon={Tag}
        title={t("tags.unknown")}
        action={
          <Button asChild variant="outline">
            <Link href="/">{t("tags.clearFilter")}</Link>
          </Button>
        }
      />
    );
  }
  if (q) {
    return (
      <div className="flex flex-col gap-6">
        <header className="flex flex-col gap-4">
          <h1 className="text-2xl font-semibold tracking-tight">{t("library.title")}</h1>
          <SearchForm q={q} tag={tag} />
          {tag ? <TagFilter tag={tag} q={q} /> : null}
        </header>
        <SearchView q={q} tag={tag} offset={Math.max(0, Number.parseInt(offset ?? "0", 10) || 0)} />
      </div>
    );
  }
  const { items, nextCursor } = await listArtifacts(getDb(), actor, {
    limit: PAGE_SIZE,
    cursor: decodeCursorOrFirstPage(cursor),
    tagId: tag?.id,
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
        <SearchForm q="" tag={tag} />
        {tag ? <TagFilter tag={tag} q="" /> : null}
      </header>

      {items.length === 0 && !cursor && tag ? (
        <p className="text-muted-foreground text-sm" data-testid="tag-empty">
          {t("tags.noArtifacts")}
        </p>
      ) : items.length === 0 && !cursor ? (
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
                tags: item.tags.map((itemTag) => itemTag.name),
              }}
            />
          ))}
        </section>
      )}

      {nextCursor ? (
        <div className="flex justify-center">
          <Button asChild variant="outline">
            <Link href={libraryHref({ tag: tag?.id, cursor: encodeCursor(nextCursor) })}>
              {t("library.loadMore")}
            </Link>
          </Button>
        </div>
      ) : null}
    </div>
  );
}
