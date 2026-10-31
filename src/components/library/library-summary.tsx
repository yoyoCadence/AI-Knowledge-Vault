import Link from "next/link";
import { label } from "@/components/library/artifact-card";
import { formatBytes, formatDate } from "@/lib/format";
import { t } from "@/lib/i18n";
import type { LibrarySummary as Summary } from "@/modules/ops";

/**
 * How many works the library holds and how they are kept (FR-LIB-1), above the library grid.
 * Every number is recorded, not estimated: an original counts as missing or corrupt once an
 * integrity check found it so. Until a check has completed, nothing is claimed about them.
 */
export function LibrarySummary({
  summary,
  canSeeUsage,
  canSeeExports,
}: {
  summary: Summary;
  canSeeUsage: boolean;
  /** Export runs are for roles that can export; others see no export date. */
  canSeeExports: boolean;
}) {
  const { library, kinds, originals } = summary;
  const problems = [
    originals.missing > 0 ? t("library.summary.missing", { count: originals.missing }) : null,
    originals.corrupt > 0 ? t("library.summary.corrupt", { count: originals.corrupt }) : null,
  ].filter((part) => part !== null);
  const checkedAt = summary.lastIntegrityCheckAt;
  return (
    <section
      aria-label={t("library.summary.title")}
      data-testid="library-summary"
      data-slot="ledger"
      className="border-border flex min-w-0 flex-col gap-2 rounded-lg border p-4 text-sm"
    >
      <p className="flex flex-wrap gap-x-4 gap-y-1">
        <span className="font-medium" data-testid="library-count">
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
        className={`flex flex-wrap gap-x-3 gap-y-1 text-xs ${problems.length > 0 ? "text-danger" : "text-muted-foreground"}`}
      >
        <span>
          {problems.length > 0
            ? t("library.summary.state", { text: problems.join("、") })
            : checkedAt
              ? t("library.summary.noProblems")
              : t("library.summary.neverChecked")}
        </span>
        {checkedAt ? (
          <span>{t("library.summary.lastCheck", { date: formatDate(checkedAt) })}</span>
        ) : null}
        {canSeeExports ? (
          <span>
            {summary.lastExportAt
              ? t("library.summary.lastExport", { date: formatDate(summary.lastExportAt) })
              : t("library.summary.neverExported")}
          </span>
        ) : null}
        {canSeeUsage ? (
          <Link href="/settings/usage" className="text-primary hover:underline">
            {t("usage.link")}
          </Link>
        ) : null}
      </p>
    </section>
  );
}
