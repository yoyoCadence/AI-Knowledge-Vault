"use client";

import { Download, FileJson, Lock, PackageOpen, ShieldAlert } from "lucide-react";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { PASSPHRASE_MAX, PASSPHRASE_MIN, RECIPIENTS_MAX } from "@/lib/backup-encryption";
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

const field =
  "border-border-strong bg-surface focus-visible:ring-ring w-full max-w-md rounded-md border px-2 py-1.5 text-sm focus-visible:ring-2 focus-visible:outline-none";

/**
 * Encrypted download (ADR-022): a plain form POST, so the browser streams the `.age` file to
 * disk however large it is. The confirmation field has no name, so only the passphrase is
 * sent; both are cleared once the request has gone.
 */
function EncryptedDownload({ exportId }: { exportId: string }) {
  const form = useRef<HTMLFormElement>(null);
  const [mode, setMode] = useState<"passphrase" | "recipients">("passphrase");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);

  function submit(event: FormEvent<HTMLFormElement>) {
    const data = new FormData(event.currentTarget);
    const problem =
      mode === "passphrase"
        ? [...String(data.get("passphrase") ?? "")].length < PASSPHRASE_MIN
          ? t("backup.encrypt.tooShort", { min: PASSPHRASE_MIN })
          : data.get("passphrase") !== confirm
            ? t("backup.encrypt.mismatch")
            : null
        : String(data.get("recipients") ?? "").trim() === ""
          ? t("backup.encrypt.noRecipients")
          : null;
    if (problem) {
      event.preventDefault();
      setError(problem);
      return;
    }
    setError(null);
    // Let the browser take the values first, then clear the secret from the page.
    setTimeout(() => {
      form.current?.reset();
      setConfirm("");
    }, 0);
  }

  return (
    <details className="text-xs" data-testid="export-encrypted">
      <summary className="text-primary w-fit cursor-pointer">
        <Lock className="mr-1 inline size-3.5 align-[-2px]" aria-hidden />
        {t("backup.encrypt.open")}
      </summary>
      <form
        ref={form}
        method="post"
        action={`/api/exports/${exportId}/encrypted`}
        onSubmit={submit}
        className="mt-2 flex flex-col gap-2"
      >
        <fieldset className="flex flex-wrap gap-3">
          <legend className="sr-only">{t("backup.encrypt.mode")}</legend>
          {(["passphrase", "recipients"] as const).map((value) => (
            <label key={value} className="flex items-center gap-1">
              <input
                type="radio"
                checked={mode === value}
                onChange={() => {
                  setMode(value);
                  setError(null);
                }}
              />
              {t(
                value === "passphrase"
                  ? "backup.encrypt.byPassphrase"
                  : "backup.encrypt.byRecipients",
              )}
            </label>
          ))}
        </fieldset>
        {mode === "passphrase" ? (
          <>
            <label className="flex flex-col gap-1">
              {t("backup.encrypt.passphrase", { min: PASSPHRASE_MIN })}
              <input
                type="password"
                name="passphrase"
                autoComplete="new-password"
                maxLength={PASSPHRASE_MAX}
                className={field}
              />
            </label>
            <label className="flex flex-col gap-1">
              {t("backup.encrypt.confirm")}
              <input
                type="password"
                autoComplete="new-password"
                value={confirm}
                onChange={(event) => setConfirm(event.target.value)}
                maxLength={PASSPHRASE_MAX}
                className={field}
              />
            </label>
          </>
        ) : (
          <label className="flex flex-col gap-1">
            {t("backup.encrypt.recipients", { max: RECIPIENTS_MAX })}
            <textarea
              name="recipients"
              rows={3}
              spellCheck={false}
              placeholder="age1…"
              className={`${field} font-mono`}
            />
          </label>
        )}
        <p className="text-muted-foreground max-w-md leading-relaxed">
          {t("backup.encrypt.custody")}
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" size="sm" data-testid="export-encrypted-submit">
            <Lock />
            {t("backup.encrypt.submit")}
          </Button>
          <a
            href={`/api/exports/${exportId}/manifest`}
            className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
          >
            <FileJson className="size-3.5" aria-hidden />
            {t("backup.encrypt.sidecar")}
          </a>
        </div>
        {error ? (
          <p role="alert" className="text-danger">
            {error}
          </p>
        ) : null}
      </form>
    </details>
  );
}

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
                {run.downloadable ? <EncryptedDownload exportId={run.id} /> : null}
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
