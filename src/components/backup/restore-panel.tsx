"use client";

import { ArchiveRestore } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatBytes, formatDateTime } from "@/lib/format";
import { t } from "@/lib/i18n";

type Tally = { restored: number; skipped: number; copied: number; failed: number };

/** Mirrors `toRestoreDto` (src/modules/backup/restore-runs.ts); dates arrive as ISO strings. */
export interface RestoreView {
  id: string;
  status: "queued" | "running" | "completed" | "failed";
  mode: "skip_existing" | "copy";
  filename: string | null;
  byteSize: number | null;
  started: boolean;
  report: {
    counts?: {
      artifacts: Tally;
      artifactVersions: Tally;
      researchProjects: Tally;
      fileAssets: { stored: number; reused: number; repaired: number };
      /** Format v2 archives (reports of earlier runs have none). */
      tags?: Tally;
      /** Format v3 archives (reports of earlier runs have none). */
      collections?: Tally;
      /** Format v4 archives (reports of earlier runs have none). */
      notes?: Tally;
    };
    warnings?: string[];
    failures?: { artifactId: string; title: string; error: string }[];
    reextractJobs?: number;
    details?: { files?: string[]; problems?: string[]; nothingWritten?: boolean };
  } | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  completedAt: string | null;
}

async function call<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = (await response.json().catch(() => ({}))) as T & {
    error?: { message?: string };
  };
  if (!response.ok) throw new Error(payload.error?.message ?? `HTTP ${response.status}`);
  return payload;
}

function upload(
  url: string,
  headers: Record<string, string>,
  file: File,
  onProgress: (percent: number) => void,
) {
  return new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    for (const [name, value] of Object.entries(headers)) xhr.setRequestHeader(name, value);
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(Math.round((event.loaded / event.total) * 100));
    };
    xhr.onload = () =>
      xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error(`HTTP ${xhr.status}`));
    xhr.onerror = () => reject(new Error("network error"));
    xhr.send(file);
  });
}

const ACTIVE = new Set(["queued", "running"]);

/** Restore from a portable export (BACKUP_RECOVERY §6), owner only. */
export function RestorePanel({ initial }: { initial: RestoreView | null }) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [mode, setMode] = useState<"skip_existing" | "copy">("skip_existing");
  const [run, setRun] = useState(initial);
  // The run this file was already uploaded to. Starting is idempotent, so after an ambiguous
  // failure (e.g. the /start response was lost) a retry starts that run again rather than
  // creating a second one, which in copy mode would restore the archive twice.
  const [uploaded, setUploaded] = useState<{ file: File; runId: string } | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const polling = run !== null && run.started && ACTIVE.has(run.status);

  useEffect(() => {
    if (!polling || !run) return;
    let inFlight = false;
    let cancelled = false;
    const timer = setInterval(async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const body = await call<{ restore: RestoreView }>(`/api/restores/${run.id}`);
        if (cancelled) return;
        setRun(body.restore);
        if (!ACTIVE.has(body.restore.status)) router.refresh();
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
  }, [polling, run, router]);

  async function start() {
    if (!file) return;
    setError(null);
    setProgress(0);
    try {
      let runId = uploaded?.file === file ? uploaded.runId : null;
      if (!runId) {
        const created = await call<{
          restore: RestoreView;
          upload: { url: string; headers: Record<string, string> };
        }>("/api/restores", { filename: file.name, size: file.size });
        setRun(created.restore);
        await upload(created.upload.url, created.upload.headers, file, setProgress);
        runId = created.restore.id;
        setUploaded({ file, runId });
      }
      const started = await call<{ restore: RestoreView }>(`/api/restores/${runId}/start`, {
        mode,
      });
      setRun(started.restore);
      setUploaded(null);
      setFile(null);
      if (inputRef.current) inputRef.current.value = "";
    } catch (startError) {
      setError(startError instanceof Error ? startError.message : String(startError));
    } finally {
      setProgress(null);
    }
  }

  const counts = run?.report?.counts;
  const busy = progress !== null || polling;
  return (
    <section className="flex flex-col gap-3" aria-labelledby="restore-backup">
      <div>
        <h2 id="restore-backup" className="text-base font-semibold">
          {t("restore.title")}
        </h2>
        <p className="text-muted-foreground mt-1 max-w-2xl text-sm leading-relaxed">
          {t("restore.description")}
        </p>
      </div>

      <div className="border-border bg-surface flex flex-col gap-3 rounded-lg border p-4 text-sm">
        <input
          ref={inputRef}
          type="file"
          accept=".zip,application/zip"
          aria-label={t("restore.choose")}
          data-testid="restore-file"
          onChange={(event) => setFile(event.target.files?.[0] ?? null)}
          disabled={busy}
        />
        <fieldset className="flex flex-col gap-2" disabled={busy}>
          <legend className="text-muted-foreground mb-1 text-xs">{t("restore.mode")}</legend>
          {(["skip_existing", "copy"] as const).map((value) => (
            <label key={value} className="flex items-start gap-2">
              <input
                type="radio"
                name="restore-mode"
                value={value}
                checked={mode === value}
                onChange={() => setMode(value)}
                className="mt-1"
              />
              <span>
                <span className="font-medium">{t(`restore.mode.${value}`)}</span>
                <span className="text-muted-foreground block text-xs">
                  {t(`restore.mode.${value}.hint`)}
                </span>
              </span>
            </label>
          ))}
        </fieldset>
        <div className="flex items-center gap-3">
          <Button onClick={start} disabled={!file || busy} data-testid="restore-start">
            <ArchiveRestore />
            {t("restore.start")}
          </Button>
          {progress !== null ? (
            <span className="text-muted-foreground text-xs">
              {t("restore.uploading", { percent: progress })}
            </span>
          ) : null}
        </div>
        {error ? <p className="text-danger text-sm">{error}</p> : null}
      </div>

      {run ? (
        <div
          className="border-border bg-surface rounded-lg border px-4 py-3 text-sm"
          data-testid="restore-result"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="truncate">
              {run.filename}
              {run.byteSize !== null ? `（${formatBytes(run.byteSize)}）` : ""} ·{" "}
              {formatDateTime(run.createdAt)}
            </span>
            <Badge
              variant={
                run.status === "completed"
                  ? (run.report?.failures?.length ?? 0) > 0
                    ? "warning"
                    : "success"
                  : run.status === "failed"
                    ? "danger"
                    : "neutral"
              }
            >
              {run.started ? t(`restore.status.${run.status}`) : t("restore.status.uploading")}
            </Badge>
          </div>
          {counts ? (
            <ul className="text-muted-foreground mt-2 flex flex-col gap-0.5 text-xs">
              <li>
                {t("restore.counts.artifacts", {
                  restored: counts.artifacts.restored,
                  skipped: counts.artifacts.skipped,
                  copied: counts.artifacts.copied,
                  failed: counts.artifacts.failed,
                })}
              </li>
              <li>
                {t("restore.counts.versions", {
                  restored: counts.artifactVersions.restored,
                  skipped: counts.artifactVersions.skipped,
                  copied: counts.artifactVersions.copied,
                  failed: counts.artifactVersions.failed,
                })}
              </li>
              <li>
                {t("restore.counts.files", {
                  stored: counts.fileAssets.stored,
                  reused: counts.fileAssets.reused,
                  repaired: counts.fileAssets.repaired,
                })}
              </li>
              {counts.tags &&
              counts.tags.restored + counts.tags.skipped + counts.tags.copied > 0 ? (
                <li>
                  {t("restore.counts.tags", {
                    restored: counts.tags.restored,
                    skipped: counts.tags.skipped,
                    copied: counts.tags.copied,
                  })}
                </li>
              ) : null}
              {counts.collections &&
              counts.collections.restored +
                counts.collections.skipped +
                counts.collections.copied +
                counts.collections.failed >
                0 ? (
                <li>
                  {t("restore.counts.collections", {
                    restored: counts.collections.restored,
                    skipped: counts.collections.skipped,
                    copied: counts.collections.copied,
                    failed: counts.collections.failed,
                  })}
                </li>
              ) : null}
              {counts.notes &&
              counts.notes.restored + counts.notes.skipped + counts.notes.copied > 0 ? (
                <li>
                  {t("restore.counts.notes", {
                    restored: counts.notes.restored,
                    skipped: counts.notes.skipped,
                    copied: counts.notes.copied,
                  })}
                </li>
              ) : null}
              {run.report?.reextractJobs ? (
                <li>{t("restore.reextract", { count: run.report.reextractJobs })}</li>
              ) : null}
            </ul>
          ) : null}
          {run.status === "failed" ? (
            <div className="text-danger mt-2 text-xs">
              <p>
                {run.errorCode}：{run.errorMessage}
              </p>
              {[...(run.report?.details?.files ?? []), ...(run.report?.details?.problems ?? [])]
                .slice(0, 10)
                .map((line) => (
                  <p key={line} className="font-mono break-all">
                    {line}
                  </p>
                ))}
              {run.report?.details?.nothingWritten ? (
                // Only failures of the verification that runs before any write (set by restore).
                <p className="text-muted-foreground mt-1">{t("restore.nothingWritten")}</p>
              ) : null}
            </div>
          ) : null}
          {(run.report?.failures ?? []).slice(0, 10).map((failure) => (
            <p key={failure.artifactId} className="text-danger mt-1 text-xs">
              {failure.title}：{failure.error}
            </p>
          ))}
          {(run.report?.warnings ?? []).length > 0 ? (
            <details className="mt-2 text-xs">
              <summary className="text-muted-foreground cursor-pointer">
                {t("restore.warnings", { count: run.report!.warnings!.length })}
              </summary>
              <ul className="mt-1 list-inside list-disc">
                {run.report!.warnings!.slice(0, 50).map((warning) => (
                  <li key={warning} className="break-all">
                    {warning}
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
