import { AlertTriangle } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { requirePageActor } from "@/app/_lib/session";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getDb } from "@/infrastructure/database/client";
import { JOB_STATUSES } from "@/infrastructure/database/schema";
import { formatBytes, formatDateTime } from "@/lib/format";
import { t, tOptional } from "@/lib/i18n";
import { roleAllows } from "@/modules/auth";
import { getUsageReport, type Tally } from "@/modules/ops";

export const metadata: Metadata = { title: t("usage.title") };

const DAY_MS = 24 * 60 * 60 * 1000;

function Row({ name, value }: { name: string; value: ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 py-1.5">
      <dt className="text-muted-foreground text-sm">{name}</dt>
      <dd className="text-sm font-medium tabular-nums">{value}</dd>
    </div>
  );
}

const files = (tally: Tally) =>
  t("usage.storage.files", { count: tally.count, size: formatBytes(tally.bytes) });

function Failure({
  title,
  code,
  error,
  at,
}: {
  title: string;
  code: string | null;
  error: string | null;
  at: Date;
}) {
  return (
    <li className="flex flex-col gap-0.5 py-2">
      <span className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-medium break-all">{title}</span>
        {code ? <Badge variant="danger">{code}</Badge> : null}
        <span className="text-muted-foreground text-xs">{formatDateTime(at)}</span>
      </span>
      {error ? (
        <span className="text-muted-foreground font-mono text-xs break-words">{error}</span>
      ) : null}
    </li>
  );
}

/** Usage and health of the workspace (FR-OPS-2/3); owners only. */
export default async function UsagePage() {
  const actor = await requirePageActor();
  if (!roleAllows(actor.role, "workspace:admin")) notFound();
  const report = await getUsageReport(getDb(), actor);
  const { storage, jobs, imports, backup } = report;
  const daysAgo = (date: Date) =>
    t("usage.backup.daysAgo", {
      days: Math.max(0, Math.floor((report.generatedAt.getTime() - date.getTime()) / DAY_MS)),
    });
  const runStatus = (status: string) => tOptional(`usage.backup.status.${status}`) ?? status;

  return (
    <div className="flex max-w-4xl flex-col gap-6" data-testid="usage">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">{t("usage.title")}</h1>
        <p className="text-muted-foreground text-sm">{t("usage.description")}</p>
        <p className="text-muted-foreground text-xs">
          {t("usage.generatedAt", { date: formatDateTime(report.generatedAt) })}
        </p>
      </header>

      <div className="grid gap-6 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>{t("usage.storage")}</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <dl className="divide-border divide-y" data-testid="usage-storage">
              <Row name={t("usage.storage.originals")} value={files(storage.originals)} />
              <Row name={t("usage.storage.previewFiles")} value={files(storage.previewFiles)} />
              <Row name={t("usage.storage.thumbnails")} value={files(storage.thumbnails)} />
              <Row name={t("usage.storage.exports")} value={files(storage.exports)} />
              <Row name={t("usage.storage.total")} value={formatBytes(storage.totalBytes)} />
            </dl>
            {storage.originals.missing + storage.originals.corrupt > 0 ? (
              <p role="alert" className="text-danger flex gap-1.5 text-sm">
                <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
                {t("usage.storage.damaged", {
                  missing: storage.originals.missing,
                  corrupt: storage.originals.corrupt,
                })}
              </p>
            ) : null}
            <p className="text-muted-foreground text-xs">{t("usage.storage.note")}</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{t("usage.backup")}</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-2 text-sm" data-testid="usage-backup">
            {backup.lastExport ? (
              <p>
                {t("usage.backup.lastExport", {
                  date: formatDateTime(backup.lastExport.completedAt),
                  size: formatBytes(backup.lastExport.bytes ?? 0),
                })}{" "}
                <span className="text-muted-foreground">
                  · {daysAgo(backup.lastExport.completedAt)}
                </span>
              </p>
            ) : (
              <p className="text-danger flex gap-1.5">
                <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
                {t("usage.backup.noExport")}
              </p>
            )}
            {backup.latestExport && backup.latestExport.id !== backup.lastExport?.id ? (
              <p className="text-muted-foreground">
                {t("usage.backup.latestExport", {
                  status: runStatus(backup.latestExport.status),
                  date: formatDateTime(backup.latestExport.createdAt),
                })}
              </p>
            ) : null}
            {backup.lastIntegrityCheck ? (
              <>
                <p>
                  {t("usage.backup.lastCheck", {
                    date: formatDateTime(backup.lastIntegrityCheck.completedAt),
                  })}{" "}
                  <span className="text-muted-foreground">
                    · {daysAgo(backup.lastIntegrityCheck.completedAt)}
                  </span>
                </p>
                <p
                  className={
                    backup.lastIntegrityCheck.missing + backup.lastIntegrityCheck.corrupt > 0
                      ? "text-danger"
                      : "text-muted-foreground"
                  }
                >
                  {t("integrity.counts", {
                    checked: backup.lastIntegrityCheck.checked,
                    ok: backup.lastIntegrityCheck.ok,
                    missing: backup.lastIntegrityCheck.missing,
                    corrupt: backup.lastIntegrityCheck.corrupt,
                  })}
                </p>
              </>
            ) : (
              <p className="text-muted-foreground">{t("usage.backup.noCheck")}</p>
            )}
            {backup.latestIntegrityCheck &&
            backup.latestIntegrityCheck.id !== backup.lastIntegrityCheck?.id ? (
              <p className="text-muted-foreground">
                {t("usage.backup.latestCheck", {
                  status: runStatus(backup.latestIntegrityCheck.status),
                  date: formatDateTime(backup.latestIntegrityCheck.startedAt),
                })}
              </p>
            ) : null}
            <Link href="/import" className="text-primary w-fit text-sm hover:underline">
              {t("usage.backup.goto")}
            </Link>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{t("usage.library")}</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3 text-sm">
            <p data-testid="usage-library">
              {t("usage.library.counts", {
                artifacts: report.library.artifacts,
                versions: report.library.versions,
              })}
            </p>
            <div>
              <p className="font-medium">
                {t("usage.database")}：
                <span data-testid="usage-database">{formatBytes(report.database.bytes)}</span>
              </p>
              <p className="text-muted-foreground text-xs">{t("usage.database.note")}</p>
            </div>
            <p className="text-muted-foreground text-xs">{t("usage.ai")}</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{t("usage.jobs")}</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <dl className="flex flex-wrap gap-x-5 gap-y-1" data-testid="usage-jobs">
              {JOB_STATUSES.map((status) => (
                <div key={status} className="flex items-baseline gap-1.5 text-sm">
                  <dt className="text-muted-foreground">{t(`usage.jobs.status.${status}`)}</dt>
                  <dd
                    className={`font-medium tabular-nums ${status === "failed" && jobs.byStatus.failed > 0 ? "text-danger" : ""}`}
                  >
                    {jobs.byStatus[status]}
                  </dd>
                </div>
              ))}
            </dl>
            <div>
              <p className="text-sm font-medium">{t("usage.jobs.recentFailures")}</p>
              {jobs.recentFailures.length > 0 ? (
                <ul className="divide-border divide-y" data-testid="usage-job-failures">
                  {jobs.recentFailures.map((job) => (
                    <Failure
                      key={job.id}
                      title={tOptional(`usage.jobType.${job.type}`) ?? job.type}
                      code={job.errorCode}
                      error={job.error}
                      at={job.failedAt}
                    />
                  ))}
                </ul>
              ) : (
                <p className="text-muted-foreground text-sm">{t("usage.jobs.noFailures")}</p>
              )}
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{t("usage.imports")}</CardTitle>
        </CardHeader>
        <CardContent>
          {imports.failed > 0 ? (
            <>
              <p className="text-sm">{t("usage.imports.count", { count: imports.failed })}</p>
              <ul className="divide-border divide-y" data-testid="usage-import-failures">
                {imports.recentFailures.map((item) => (
                  <Failure
                    key={item.id}
                    title={item.filename}
                    code={item.errorCode}
                    error={item.error}
                    at={item.failedAt}
                  />
                ))}
              </ul>
            </>
          ) : (
            <p className="text-muted-foreground text-sm">{t("usage.imports.none")}</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
