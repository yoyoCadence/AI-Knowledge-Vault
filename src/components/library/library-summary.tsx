import Link from "next/link";
import { label } from "@/components/library/artifact-card";
import { formatBytes, formatDate } from "@/lib/format";
import { t } from "@/lib/i18n";
import type { LibrarySummary as Summary } from "@/modules/ops";

/**
 * How many works the library holds and how they are kept (FR-LIB-1), above the library grid.
 * Every number is recorded, not estimated: an original counts as missing or corrupt once an
 * integrity check found it so, which is why the last check's date is shown next to it.
 */
export function LibrarySummary({
  summary,
  canSeeUsage,
}: {
  summary: Summary;
  canSeeUsage: boolean;
}) {
  const { library, kinds, originals } = summary;
  const problems = originals.missing + originals.corrupt > 0;
  return (
    <section
      aria-label={t("library.summary.title")}
      data-testid="library-summary"
      className="border-border flex min-w-0 flex-col gap-2 rounded-lg border p-4 text-sm"
    >
      <p className="flex flex-wrap gap-x-4 gap-y-1">
        <span className="font-medium">
          {t("library.summary.artifacts", { count: library.artifacts })}
        </span>
        <span>{t("library.summary.versions", { count: library.versions })}</span>
        <span>
          {t("library.summary.originals", {
            count: originals.count,
            size: formatBytes(originals.bytes),
          })}
        </span>
      </p>
      {kinds.length > 0 ? (
        <ul aria-label={t("library.summary.kinds")} className="flex flex-wrap gap-1.5">
          {kinds.map(({ kind, count }) => (
            <li key={kind}>
              <Link
                href={`/?kind=${kind}`}
                className="border-border text-muted-foreground hover:text-foreground inline-block rounded-full border px-2.5 py-0.5 text-xs"
              >
                {t("library.summary.kind", { kind: label("kind", kind), count })}
              </Link>
            </li>
          ))}
        </ul>
      ) : null}
      <p
        data-testid="library-preservation"
        className={`flex flex-wrap gap-x-3 gap-y-1 text-xs ${problems ? "text-danger" : "text-muted-foreground"}`}
      >
        <span>
          {problems
            ? t("library.summary.problems", {
                missing: originals.missing,
                corrupt: originals.corrupt,
              })
            : t("library.summary.noProblems")}
        </span>
        <span>
          {summary.lastIntegrityCheckAt
            ? t("library.summary.lastCheck", { date: formatDate(summary.lastIntegrityCheckAt) })
            : t("library.summary.neverChecked")}
        </span>
        <span>
          {summary.lastExportAt
            ? t("library.summary.lastExport", { date: formatDate(summary.lastExportAt) })
            : t("library.summary.neverExported")}
        </span>
        {canSeeUsage ? (
          <Link href="/settings/usage" className="text-primary hover:underline">
            {t("library.summary.details")}
          </Link>
        ) : null}
      </p>
    </section>
  );
}
