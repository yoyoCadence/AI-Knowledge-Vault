import { Search, SlidersHorizontal } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { t } from "@/lib/i18n";

export interface LibraryControlValues {
  q: string;
  tag?: string;
  project?: string;
  collection?: string;
  kind?: string;
  model?: string;
  from?: string;
  to?: string;
  favorite?: string;
  status?: string;
  sort?: string;
}

export interface Option {
  value: string;
  label: string;
}

/** An option of a tree, indented by its depth (a select cannot nest options). */
export interface TreeOption extends Option {
  depth: number;
}

const indent = (depth: number) => "\u3000".repeat(depth);

const field =
  "border-border-strong bg-surface focus-visible:ring-ring h-9 rounded-md border px-2 text-sm focus-visible:ring-2 focus-visible:outline-none";

/**
 * Search box plus filters and sort, as one plain GET form: it works without client JavaScript
 * and every view of the library has a shareable URL. The tag filter is carried along hidden
 * (tags are chosen from chips, not here).
 */
export function LibraryControls({
  values,
  projects,
  collections,
  kinds,
  statuses,
  models,
  sorts,
  filtered,
  clearHref,
}: {
  values: LibraryControlValues;
  projects: Option[];
  collections: TreeOption[];
  statuses: Option[];
  kinds: Option[];
  models: string[];
  sorts: Option[];
  /** Any filter other than the search text is active. */
  filtered: boolean;
  clearHref: string;
}) {
  return (
    <form action="/" method="get" role="search" className="flex w-full flex-col gap-3">
      {values.tag ? <input type="hidden" name="tag" value={values.tag} /> : null}
      <div className="flex w-full max-w-xl gap-2">
        <label className="sr-only" htmlFor="library-search">
          {t("search.label")}
        </label>
        <input
          id="library-search"
          name="q"
          type="search"
          defaultValue={values.q}
          maxLength={200}
          placeholder={t("search.placeholder")}
          className={`${field} min-w-0 flex-1 px-3`}
        />
        <Button type="submit" variant="outline">
          <Search />
          {t("search.submit")}
        </Button>
      </div>
      <details open={filtered} className="text-sm" data-testid="library-filters">
        <summary className="text-muted-foreground hover:text-foreground inline-flex cursor-pointer items-center gap-1.5">
          <SlidersHorizontal className="size-4" aria-hidden />
          {t("filters.title")}
        </summary>
        <div className="mt-3 flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1">
            <span className="text-muted-foreground text-xs">{t("filters.project")}</span>
            <select name="project" defaultValue={values.project ?? ""} className={field}>
              <option value="">{t("filters.anyProject")}</option>
              {projects.map((project) => (
                <option key={project.value} value={project.value}>
                  {project.label}
                </option>
              ))}
            </select>
          </label>
          {collections.length > 0 ? (
            <label className="flex flex-col gap-1">
              <span className="text-muted-foreground text-xs">{t("filters.collection")}</span>
              <select name="collection" defaultValue={values.collection ?? ""} className={field}>
                <option value="">{t("filters.anyCollection")}</option>
                {collections.map((collection) => (
                  <option key={collection.value} value={collection.value}>
                    {indent(collection.depth) + collection.label}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <label className="flex flex-col gap-1">
            <span className="text-muted-foreground text-xs">{t("filters.kind")}</span>
            <select name="kind" defaultValue={values.kind ?? ""} className={field}>
              <option value="">{t("filters.anyKind")}</option>
              {kinds.map((kind) => (
                <option key={kind.value} value={kind.value}>
                  {kind.label}
                </option>
              ))}
            </select>
          </label>
          {models.length > 0 ? (
            <label className="flex flex-col gap-1">
              <span className="text-muted-foreground text-xs">{t("filters.model")}</span>
              <select name="model" defaultValue={values.model ?? ""} className={field}>
                <option value="">{t("filters.anyModel")}</option>
                {models.map((model) => (
                  <option key={model} value={model}>
                    {model}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <label className="flex flex-col gap-1">
            <span className="text-muted-foreground text-xs">{t("filters.from")}</span>
            <input type="date" name="from" defaultValue={values.from ?? ""} className={field} />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-muted-foreground text-xs">{t("filters.to")}</span>
            <input type="date" name="to" defaultValue={values.to ?? ""} className={field} />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-muted-foreground text-xs">{t("filters.status")}</span>
            <select name="status" defaultValue={values.status ?? ""} className={field}>
              <option value="">{t("filters.anyStatus")}</option>
              {statuses.map((status) => (
                <option key={status.value} value={status.value}>
                  {status.label}
                </option>
              ))}
            </select>
          </label>
          <label className="flex h-9 items-center gap-2">
            <input
              type="checkbox"
              name="favorite"
              value="1"
              defaultChecked={values.favorite === "1"}
              className="accent-primary size-4"
            />
            <span>{t("filters.favorite")}</span>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-muted-foreground text-xs">{t("filters.sort")}</span>
            <select name="sort" defaultValue={values.sort ?? sorts[0]?.value} className={field}>
              {sorts.map((sort) => (
                <option key={sort.value} value={sort.value}>
                  {sort.label}
                </option>
              ))}
            </select>
          </label>
          <Button type="submit" variant="outline" data-testid="filters-apply">
            {t("filters.apply")}
          </Button>
          {filtered ? (
            <Link href={clearHref} className="text-muted-foreground hover:text-foreground py-2">
              {t("filters.clear")}
            </Link>
          ) : null}
        </div>
      </details>
    </form>
  );
}
