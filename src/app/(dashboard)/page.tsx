import { FolderKanban, FolderTree, Library, Tag, Upload, X } from "lucide-react";
import Link from "next/link";
import { requirePageActor } from "@/app/_lib/session";
import { ArtifactCard, label } from "@/components/library/artifact-card";
import { LibraryControls } from "@/components/library/library-controls";
import { SearchResults } from "@/components/library/search-results";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/states";
import { getDb } from "@/infrastructure/database/client";
import { CONTENT_KINDS } from "@/infrastructure/database/schema";
import { decodeCursorOrFirstPage, encodeCursor } from "@/lib/cursor";
import { t } from "@/lib/i18n";
import { isUuid } from "@/lib/ids";
import {
  dayParam,
  firstParam,
  modelParam,
  searchQueryParam,
  type PageSearchParams,
} from "@/lib/search-params";
import {
  hasFilters,
  LIBRARY_SORTS,
  listArtifacts,
  listSourceModels,
  type LibraryFilters,
  type LibrarySort,
} from "@/modules/artifacts";
import { collectionOptions, findCollection } from "@/modules/collections";
import { findProject, listProjects } from "@/modules/projects";
import { SEARCH_SORTS, searchArtifacts, type SearchSort } from "@/modules/search";
import { findTag } from "@/modules/tags";

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

function oneOf<T extends string>(value: string | undefined, allowed: readonly T[]) {
  return allowed.includes(value as T) ? (value as T) : undefined;
}

/** A filter the page cannot honour (another workspace's or a deleted tag, project or collection). */
function UnknownFilter({ title, clearLabel }: { title: string; clearLabel: string }) {
  return (
    <EmptyState
      icon={Tag}
      title={title}
      action={
        <Button asChild variant="outline">
          <Link href="/">{clearLabel}</Link>
        </Button>
      }
    />
  );
}

/** An active tag, project or collection filter, with a link that removes just that filter. */
function ActiveFilter({
  icon: Icon,
  text,
  clearHref,
  clearLabel,
  testId,
}: {
  icon: typeof Tag;
  text: string;
  clearHref: string;
  clearLabel: string;
  testId: string;
}) {
  return (
    <p className="flex flex-wrap items-center gap-2 text-sm" data-testid={testId}>
      <Icon className="text-muted-foreground size-4" aria-hidden />
      {text}
      <Link
        href={clearHref}
        className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
      >
        <X className="size-3.5" aria-hidden />
        {clearLabel}
      </Link>
    </p>
  );
}

export default async function LibraryPage({
  searchParams,
}: {
  searchParams: Promise<PageSearchParams>;
}) {
  const actor = await requirePageActor();
  const db = getDb();
  const params = await searchParams;
  const q = searchQueryParam(params.q);

  // Another workspace's (or a deleted) tag or project is indistinguishable from a missing one.
  const tagParam = firstParam(params.tag);
  const tag = tagParam && isUuid(tagParam) ? await findTag(db, actor, tagParam) : null;
  if (tagParam && !tag) {
    return <UnknownFilter title={t("tags.unknown")} clearLabel={t("tags.clearFilter")} />;
  }
  const projectParam = firstParam(params.project);
  const project =
    projectParam && isUuid(projectParam) ? await findProject(db, actor, projectParam) : null;
  if (projectParam && !project) {
    return <UnknownFilter title={t("projects.unknown")} clearLabel={t("filters.clear")} />;
  }
  const collectionParam = firstParam(params.collection);
  const collection =
    collectionParam && isUuid(collectionParam)
      ? await findCollection(db, actor, collectionParam)
      : null;
  if (collectionParam && !collection) {
    return <UnknownFilter title={t("collections.unknown")} clearLabel={t("filters.clear")} />;
  }

  const filters: LibraryFilters = {
    tagId: tag?.id,
    projectId: project?.id,
    collectionId: collection?.id,
    kind: oneOf(firstParam(params.kind), CONTENT_KINDS),
    sourceModel: modelParam(params.model),
    from: dayParam(params.from),
    to: dayParam(params.to),
  };
  const sort: LibrarySort | SearchSort | undefined = q
    ? oneOf(firstParam(params.sort), SEARCH_SORTS)
    : oneOf(firstParam(params.sort), LIBRARY_SORTS);
  const state = {
    q,
    tag: filters.tagId,
    project: filters.projectId,
    collection: filters.collectionId,
    kind: filters.kind,
    model: filters.sourceModel,
    from: filters.from,
    to: filters.to,
    sort,
  };
  // Filters set in the form (the tag comes from chips and has its own line).
  const filtered = hasFilters({ ...filters, tagId: undefined }) || sort !== undefined;

  const [projects, collections, models] = await Promise.all([
    listProjects(db, actor),
    collectionOptions(db, actor),
    listSourceModels(db, actor),
  ]);
  const controls = (
    <LibraryControls
      values={state}
      projects={projects
        .filter((option) => option.status === "active" || option.id === project?.id)
        .map((option) => ({ value: option.id, label: option.title }))}
      collections={collections.map((option) => ({
        value: option.id,
        label: option.name,
        depth: option.depth,
      }))}
      kinds={CONTENT_KINDS.map((kind) => ({ value: kind, label: label("kind", kind) }))}
      models={models}
      sorts={(q ? SEARCH_SORTS : LIBRARY_SORTS).map((value) => ({
        value,
        label: t(`sort.${value}`),
      }))}
      filtered={filtered}
      clearHref={libraryHref({ q, tag: state.tag })}
    />
  );
  const activeFilters = (
    <>
      {tag ? (
        <ActiveFilter
          icon={Tag}
          text={t("tags.filtered", { name: tag.name })}
          clearHref={libraryHref({ ...state, tag: undefined })}
          clearLabel={t("tags.clearFilter")}
          testId="tag-filter"
        />
      ) : null}
      {project ? (
        <ActiveFilter
          icon={FolderKanban}
          text={t("projects.filtered", { title: project.title })}
          clearHref={libraryHref({ ...state, project: undefined })}
          clearLabel={t("projects.clearFilter")}
          testId="project-filter"
        />
      ) : null}
      {collection ? (
        <ActiveFilter
          icon={FolderTree}
          text={t("collections.filtered", { name: collection.name })}
          clearHref={libraryHref({ ...state, collection: undefined })}
          clearLabel={t("collections.clearFilter")}
          testId="collection-filter"
        />
      ) : null}
    </>
  );

  if (q) {
    const offset = Math.max(0, Number.parseInt(firstParam(params.offset) ?? "0", 10) || 0);
    const { items, nextOffset, total, terms } = await searchArtifacts(db, actor, {
      q,
      offset,
      filters,
      sort: sort as SearchSort | undefined,
    });
    return (
      <div className="flex flex-col gap-6">
        <header className="flex flex-col gap-4">
          <h1 className="text-2xl font-semibold tracking-tight">{t("library.title")}</h1>
          {controls}
          {activeFilters}
        </header>
        <section aria-label={t("search.results", { q })} className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-base font-semibold">
              {t("search.results", { q })}
              {total ? (
                <span
                  className="text-muted-foreground ml-2 text-sm font-normal"
                  data-testid="search-total"
                >
                  {t("search.total", { count: total })}
                </span>
              ) : null}
            </h2>
            <Link
              href={libraryHref({ ...state, q: undefined, sort: undefined })}
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
                <Link href={libraryHref({ ...state, offset: nextOffset })}>
                  {t("library.loadMore")}
                </Link>
              </Button>
            </div>
          ) : null}
        </section>
      </div>
    );
  }

  const cursor = firstParam(params.cursor);
  const { items, nextCursor } = await listArtifacts(db, actor, {
    limit: PAGE_SIZE,
    cursor: decodeCursorOrFirstPage(cursor),
    filters,
    sort: sort as LibrarySort | undefined,
  });
  const anyFilter = hasFilters(filters);

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
        {controls}
        {activeFilters}
      </header>

      {items.length === 0 && !cursor && anyFilter ? (
        <p className="text-muted-foreground text-sm" data-testid="filtered-empty">
          {tag && !hasFilters({ ...filters, tagId: undefined })
            ? t("tags.noArtifacts")
            : t("filters.none")}
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
            <Link href={libraryHref({ ...state, cursor: encodeCursor(nextCursor) })}>
              {t("library.loadMore")}
            </Link>
          </Button>
        </div>
      ) : null}
    </div>
  );
}
