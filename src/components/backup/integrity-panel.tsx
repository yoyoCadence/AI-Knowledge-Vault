"use client";

import { ShieldCheck } from "lucide-react";
import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatDateTime } from "@/lib/format";
import { t } from "@/lib/i18n";

/** Mirrors `toIntegrityDto` (src/modules/backup/integrity.ts); dates arrive as ISO strings. */
export interface IntegrityView {
  id: string;
  status: "queued" | "running" | "completed" | "failed";
  checkedCount: number;
  okCount: number;
  missingCount: number;
  corruptCount: number;
  failures: { fileAssetId: string; originalFilename: string; status: "missing" | "corrupt" }[];
  startedAt: string;
  completedAt: string | null;
}

const ACTIVE = new Set(["queued", "running"]);

/** Integrity check (BACKUP_RECOVERY §7): last result, and a button to re-verify every original. */
export function IntegrityPanel({
  initial,
  canRun,
}: {
  initial: IntegrityView | null;
  canRun: boolean;
}) {
  const [check, setCheck] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const active = check !== null && ACTIVE.has(check.status);

  useEffect(() => {
    if (!active) return;
    let inFlight = false;
    let cancelled = false;
    const timer = setInterval(async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const response = await fetch("/api/integrity-checks/latest");
        if (!response.ok) return;
        const body = (await response.json()) as { check: IntegrityView | null };
        if (!cancelled) setCheck(body.check);
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

  async function run() {
    setError(null);
    try {
      const response = await fetch("/api/integrity-checks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      const body = (await response.json()) as {
        check?: IntegrityView;
        error?: { message?: string };
      };
      if (!response.ok || !body.check)
        throw new Error(body.error?.message ?? `HTTP ${response.status}`);
      setCheck(body.check);
    } catch (runError) {
      setError(runError instanceof Error ? runError.message : String(runError));
    }
  }

  const damaged = check ? check.missingCount + check.corruptCount : 0;
  return (
    <section className="flex flex-col gap-3" aria-labelledby="integrity-check">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 id="integrity-check" className="text-base font-semibold">
            {t("integrity.title")}
          </h2>
          <p className="text-muted-foreground mt-1 max-w-2xl text-sm leading-relaxed">
            {t("integrity.description")}
          </p>
        </div>
        {canRun ? (
          <Button variant="outline" onClick={run} disabled={active} data-testid="integrity-run">
            <ShieldCheck />
            {active ? t("integrity.running") : t("integrity.run")}
          </Button>
        ) : null}
      </div>
      {error ? <p className="text-danger text-sm">{error}</p> : null}
      {check === null ? (
        <p className="text-muted-foreground text-sm">{t("integrity.never")}</p>
      ) : (
        <div className="surface-panel px-4 py-3 text-sm" data-testid="integrity-result">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span>
              {check.completedAt
                ? t("integrity.lastChecked", { date: formatDateTime(check.completedAt) })
                : formatDateTime(check.startedAt)}
            </span>
            <Badge
              variant={
                check.status === "failed" || damaged > 0
                  ? "danger"
                  : check.status === "completed"
                    ? "success"
                    : "neutral"
              }
            >
              {check.status === "completed"
                ? damaged > 0
                  ? t("integrity.damaged", { count: damaged })
                  : t("integrity.ok")
                : t(`integrity.status.${check.status}`)}
            </Badge>
          </div>
          {check.status === "completed" ? (
            <p className="text-muted-foreground mt-1 text-xs">
              {t("integrity.counts", {
                checked: check.checkedCount,
                ok: check.okCount,
                missing: check.missingCount,
                corrupt: check.corruptCount,
              })}
            </p>
          ) : null}
          {check.failures.length > 0 ? (
            <ul className="text-danger mt-2 list-inside list-disc text-xs">
              {check.failures.map((failure) => (
                <li key={failure.fileAssetId}>
                  {failure.originalFilename}：{t(`integrity.failure.${failure.status}`)}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      )}
    </section>
  );
}
