"use client";

import { Download, PackageOpen, ShieldAlert } from "lucide-react";
import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatBytes, formatDateTime } from "@/lib/format";
import { t, tOptional } from "@/lib/i18n";

/** Mirrors `toExportDto` (src/modules/backup/service.ts); dates arrive as ISO strings. */
export interface ExportView {
  id: string;
  status: "queued" | "running" | "completed" | "failed";
  byteSize: number | null;
  sha256: string | null;
  summary: {
    counts?: { artifacts: number; artifactVersions: number; fileAssets: number };
  } | null;
  errorMessage: string | null;
  createdAt: string;
  expiresAt: string | null;
  downloadable: boolean;
}

const ACTIVE = new Set(["queued", "running"]);

/** Portable export (BACKUP_RECOVERY §3): request, follow progress, download the archive. */
export function ExportPanel({ initial }: { initial: ExportView[] }) {
  const [runs, setRuns] = useState(initial);
  const [requesting, setRequesting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const active = runs.some((run) => ACTIVE.has(run.status));

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    let inFlight = false;
    const timer = setInterval(async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const response = await fetch("/api/exports");
        if (!response.ok) return;
        const body = (await response.json()) as { items: ExportView[] };
        if (!cancelled) setRuns(body.items);
      } catch {
        /* transient: the next tick retries */
      } finally {
        inFlight = false;
      }
    }, 2000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [active]);

  async function requestExport() {
    setRequesting(true);
    setError(null);
    try {
      const response = await fetch("/api/exports", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      const body = (await response.json()) as {
        export?: ExportView;
        error?: { message?: string };
      };
      if (!response.ok || !body.export)
        throw new Error(body.error?.message ?? `HTTP ${response.status}`);
      setRuns((current) => [body.export!, ...current]);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : String(requestError));
    } finally {
      setRequesting(false);
    }
  }

  return (
    <section className="flex flex-col gap-3" aria-labelledby="portable-export">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 id="portable-export" className="text-base font-semibold">
            {t("backup.title")}
          </h2>
          <p className="text-muted-foreground mt-1 max-w-2xl text-sm leading-relaxed">
            {t("backup.description")}
          </p>
        </div>
        <Button onClick={requestExport} disabled={requesting || active} data-testid="export-create">
          <PackageOpen />
          {requesting ? t("backup.creating") : t("backup.create")}
        </Button>
      </div>

      <p className="border-warning/40 bg-warning/10 flex items-start gap-2 rounded-md border px-3 py-2 text-sm">
        <ShieldAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
        <span>{t("backup.unencrypted")}</span>
      </p>
      {error ? <p className="text-danger text-sm">{error}</p> : null}

      {runs.length === 0 ? (
        <p className="text-muted-foreground text-sm">{t("backup.empty")}</p>
      ) : (
        <ul className="divide-border border-border bg-surface divide-y rounded-lg border text-sm">
          {runs.map((run) => {
            const counts = run.summary?.counts;
            const expired = run.status === "completed" && !run.downloadable;
            return (
              <li key={run.id} className="flex flex-col gap-1.5 px-4 py-3" data-testid="export-row">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span>{formatDateTime(run.createdAt)}</span>
                  <span className="flex items-center gap-2">
                    <Badge
                      variant={
                        run.status === "completed" && !expired
                          ? "success"
                          : run.status === "failed"
                            ? "danger"
                            : "neutral"
                      }
                    >
                      {expired
                        ? t("backup.expired")
                        : (tOptional(`backup.status.${run.status}`) ?? run.status)}
                    </Badge>
                    {run.downloadable ? (
                      <Button asChild size="sm" variant="outline">
                        <a href={`/api/exports/${run.id}/download`} data-testid="export-download">
                          <Download />
                          {t("backup.download")}
                          {run.byteSize !== null ? `（${formatBytes(run.byteSize)}）` : ""}
                        </a>
                      </Button>
                    ) : null}
                  </span>
                </div>
                {counts ? (
                  <p className="text-muted-foreground text-xs">
                    {t("backup.summary", {
                      artifacts: counts.artifacts,
                      versions: counts.artifactVersions,
                      files: counts.fileAssets,
                    })}
                    {run.downloadable && run.expiresAt
                      ? ` · ${t("backup.expires", { date: formatDateTime(run.expiresAt) })}`
                      : ""}
                  </p>
                ) : null}
                {run.sha256 ? (
                  <p className="text-muted-foreground font-mono text-xs break-all">
                    SHA-256 {run.sha256}
                  </p>
                ) : null}
                {run.status === "failed" && run.errorMessage ? (
                  <p className="text-danger text-xs">{run.errorMessage}</p>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
      <p className="text-muted-foreground text-xs leading-relaxed">{t("backup.restoreHint")}</p>
    </section>
  );
}
