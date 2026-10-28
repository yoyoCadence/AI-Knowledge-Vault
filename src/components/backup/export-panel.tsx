"use client";

import { Download, FileJson, Lock, PackageOpen, ShieldAlert } from "lucide-react";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  PASSPHRASE_MAX,
  PASSPHRASE_MIN,
  passphraseProblem,
  RECIPIENTS_MAX,
  recipientsFrom,
  recipientsProblem,
} from "@/lib/backup-encryption";
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

/** What the owner typed, checked by the rules the server applies (`@/lib/backup-encryption`). */
function choiceProblem(
  mode: "passphrase" | "recipients",
  passphrase: string,
  confirmation: string,
  recipients: string,
): string | null {
  if (mode === "recipients") {
    const problem = recipientsProblem(recipientsFrom(recipients));
    if (problem === "none") return t("backup.encrypt.noRecipients");
    if (problem === "count") return t("backup.encrypt.tooManyRecipients", { max: RECIPIENTS_MAX });
    return problem ? t("backup.encrypt.recipientFormat") : null;
  }
  const problem = passphraseProblem(passphrase);
  if (problem === "characters") return t("backup.encrypt.characters");
  if (problem) return t("backup.encrypt.length", { min: PASSPHRASE_MIN, max: PASSPHRASE_MAX });
  return passphrase === confirmation ? null : t("backup.encrypt.mismatch");
}

/**
 * Encrypted download (ADR-022): a plain form POST, so the browser streams the `.age` file to
 * disk however large it is. A form's error would replace the page with JSON, so the panel
 * checks first what it can: the choice, by the server's rules, and that the session and the
 * export are still good (the sidecar answers 401 or 409 as the download would). The fields
 * are uncontrolled, so the secret is never mirrored into React state or the DOM; the
 * confirmation has no name and is never sent. Both are cleared once the request has gone.
 */
function EncryptedDownload({ exportId }: { exportId: string }) {
  const form = useRef<HTMLFormElement>(null);
  const confirmation = useRef<HTMLInputElement>(null);
  const [mode, setMode] = useState<"passphrase" | "recipients">("passphrase");
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const element = event.currentTarget;
    const data = new FormData(element);
    const problem = choiceProblem(
      mode,
      String(data.get("passphrase") ?? ""),
      confirmation.current?.value ?? "",
      String(data.get("recipients") ?? ""),
    );
    if (problem) {
      setError(problem);
      return;
    }
    setError(null);
    setChecking(true);
    try {
      const response = await fetch(`/api/exports/${exportId}/manifest`, { cache: "no-store" });
      if (!response.ok) {
        setError(
          response.status === 401
            ? t("backup.encrypt.signedOut")
            : response.status === 409 || response.status === 404
              ? t("backup.encrypt.unavailable")
              : t("backup.encrypt.checkFailed", { status: response.status }),
        );
        return;
      }
    } catch {
      setError(t("backup.encrypt.checkFailed", { status: "network" }));
      return;
    } finally {
      setChecking(false);
    }
    // `submit()` sends the form as it is, without this handler; then the secret leaves the page.
    element.submit();
    setTimeout(() => form.current?.reset(), 0);
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
        noValidate
        className="mt-2 flex flex-col gap-2"
      >
        {/* For password managers: what a saved passphrase belongs to (never sent: no name). */}
        <input
          type="text"
          autoComplete="username"
          value="vault-backup-encryption"
          readOnly
          hidden
        />
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
                aria-describedby={`${exportId}-passphrase-hint`}
                className={field}
              />
            </label>
            <p id={`${exportId}-passphrase-hint`} className="text-muted-foreground -mt-1">
              {t("backup.encrypt.asciiHint")}
            </p>
            <label className="flex flex-col gap-1">
              {t("backup.encrypt.confirm")}
              <input
                ref={confirmation}
                type="password"
                autoComplete="new-password"
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
              autoCapitalize="off"
              autoCorrect="off"
              placeholder="age1…"
              className={`${field} font-mono`}
            />
          </label>
        )}
        <p className="text-muted-foreground max-w-md leading-relaxed">
          {t("backup.encrypt.custody")}
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" size="sm" disabled={checking} data-testid="export-encrypted-submit">
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
