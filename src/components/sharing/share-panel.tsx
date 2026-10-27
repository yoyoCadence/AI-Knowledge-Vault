"use client";

import { Copy, Link2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";
import { jsonRequest } from "@/components/artifacts/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatDateTime } from "@/lib/format";
import { t, tOptional } from "@/lib/i18n";
import type { ShareFinding } from "@/modules/sharing";

/** A link as the panel shows it (dates as ISO strings); its token is never known here. */
export interface ShareRow {
  id: string;
  label: string | null;
  allowPreview: boolean;
  allowReading: boolean;
  allowDownload: boolean;
  expiresAt: string | null;
  revokedAt: string | null;
  createdAt: string;
  lastAccessedAt: string | null;
  accessCount: number;
  active: boolean;
}

interface CheckResult {
  findings: ShareFinding[];
  blocked: boolean;
  visibility: string;
}

const field =
  "border-border-strong bg-surface focus-visible:ring-ring rounded-md border px-2 py-1.5 text-sm focus-visible:ring-2 focus-visible:outline-none";

const EXPIRY_DAYS = [1, 7, 30, 90, 365] as const;

const messages = {
  invalid: t("share.error.invalid"),
  gone: t("share.error.gone"),
  conflict: t("share.error.conflict"),
};

function findingText(finding: ShareFinding): string {
  const text =
    tOptional(`share.finding.${finding.kind}`)?.replace("{count}", String(finding.count)) ??
    finding.kind;
  // The sensitivity finding's sample is the label itself; the others' are masked matches.
  return finding.kind === "sensitive" || finding.samples.length === 0
    ? text
    : `${text}（${t("share.finding.samples", { samples: finding.samples.join("、") })}）`;
}

function status(row: ShareRow): { text: string; variant: "success" | "neutral" | "warning" } {
  if (row.revokedAt) return { text: t("share.status.revoked"), variant: "neutral" };
  if (!row.active) return { text: t("share.status.expired"), variant: "warning" };
  return { text: t("share.status.active"), variant: "success" };
}

/**
 * Share links of one artifact (FR-SHR): the pre-share check, then the link's options, then its
 * URL, shown once (only its hash is stored). Lists the links with their use, revokes them, and
 * turns the artifact private again, which revokes them all.
 */
export function SharePanel({
  artifactId,
  visibility,
  shares,
}: {
  artifactId: string;
  visibility: string;
  shares: ShareRow[];
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [check, setCheck] = useState<CheckResult | null>(null);
  const [createdUrl, setCreatedUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [allowReading, setAllowReading] = useState(true);
  const [allowPreview, setAllowPreview] = useState(true);
  const [allowDownload, setAllowDownload] = useState(false);
  const [label, setLabel] = useState("");
  const [expiryDays, setExpiryDays] = useState("30");

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("edit.error.generic"));
    } finally {
      setBusy(false);
    }
  }

  const startCheck = () =>
    run(async () => {
      setCreatedUrl(null);
      setCheck(
        await jsonRequest<CheckResult>(
          `/api/artifacts/${artifactId}/share-check`,
          { method: "POST" },
          messages,
        ),
      );
    });

  function create(event: FormEvent) {
    event.preventDefault();
    if (!allowReading && !allowPreview && !allowDownload) return;
    void run(async () => {
      const days = Number(expiryDays);
      const result = await jsonRequest<{ url: string }>(
        `/api/artifacts/${artifactId}/shares`,
        {
          method: "POST",
          body: {
            label: label.trim() || null,
            allowReading,
            allowPreview,
            allowDownload,
            expiresAt: days > 0 ? new Date(Date.now() + days * 86_400_000).toISOString() : null,
            acknowledgeFindings: true,
          },
        },
        messages,
      );
      setCheck(null);
      setLabel("");
      setCopied(false);
      setCreatedUrl(result.url);
      router.refresh();
    });
  }

  const revoke = (id: string) =>
    run(async () => {
      await jsonRequest(`/api/shares/${id}`, { method: "DELETE" }, messages);
      setConfirming(null);
      router.refresh();
    });

  const makePrivate = () =>
    run(async () => {
      await jsonRequest(
        `/api/artifacts/${artifactId}/visibility`,
        { method: "PUT", body: { visibility: "private" } },
        messages,
      );
      setConfirming(null);
      setCreatedUrl(null);
      router.refresh();
    });

  async function copy(url: string) {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  const noPermission = !allowReading && !allowPreview && !allowDownload;

  return (
    <div className="flex flex-col gap-4 text-sm" data-testid="share-panel">
      <p className="text-muted-foreground" data-testid="share-visibility">
        {visibility === "private"
          ? t("share.visibility.private")
          : visibility === "unlisted"
            ? t("share.visibility.unlisted")
            : t("visibility.public")}
      </p>

      {createdUrl ? (
        <div className="border-border flex flex-col gap-2 rounded-md border p-3" role="status">
          <p>{t("share.created")}</p>
          <div className="flex gap-2">
            <input
              readOnly
              value={createdUrl}
              aria-label={t("share.section")}
              onFocus={(event) => event.currentTarget.select()}
              className={`${field} min-w-0 flex-1 font-mono text-xs`}
              data-testid="share-url"
            />
            <Button size="sm" variant="outline" onClick={() => void copy(createdUrl)}>
              <Copy />
              {copied ? t("share.copied") : t("share.copy")}
            </Button>
          </div>
          <Button size="sm" variant="ghost" className="w-fit" onClick={() => setCreatedUrl(null)}>
            {t("share.done")}
          </Button>
        </div>
      ) : null}

      {check ? (
        <form
          onSubmit={create}
          className="border-border flex flex-col gap-3 rounded-md border p-3"
          data-testid="share-form"
        >
          <p className="font-medium">{t("share.check.title")}</p>
          {check.findings.length > 0 ? (
            <ul className="flex list-disc flex-col gap-1 pl-5" data-testid="share-findings">
              {check.findings.map((finding) => (
                <li key={finding.kind} className="break-words">
                  {findingText(finding)}
                </li>
              ))}
            </ul>
          ) : (
            <p>{t("share.check.none")}</p>
          )}
          <p className="text-muted-foreground text-xs">{t("share.check.advisory")}</p>
          {check.blocked ? (
            <p role="alert" className="text-danger">
              {t("share.check.blocked")}
            </p>
          ) : (
            <>
              <fieldset className="flex flex-col gap-1.5">
                {(
                  [
                    ["reading", allowReading, setAllowReading],
                    ["preview", allowPreview, setAllowPreview],
                    ["download", allowDownload, setAllowDownload],
                  ] as const
                ).map(([name, checked, set]) => (
                  <label key={name} className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={(event) => set(event.target.checked)}
                      name={name}
                    />
                    {t(`share.option.${name}`)}
                  </label>
                ))}
              </fieldset>
              <label className="flex flex-col gap-1">
                {t("share.option.expiry")}
                <select
                  value={expiryDays}
                  onChange={(event) => setExpiryDays(event.target.value)}
                  className={field}
                  name="expiry"
                >
                  {EXPIRY_DAYS.map((days) => (
                    <option key={days} value={String(days)}>
                      {t("share.expiry.days", { days })}
                    </option>
                  ))}
                  <option value="0">{t("share.expiry.never")}</option>
                </select>
              </label>
              <label className="flex flex-col gap-1">
                {t("share.option.label")}
                <input
                  value={label}
                  onChange={(event) => setLabel(event.target.value)}
                  maxLength={100}
                  className={field}
                  name="label"
                />
              </label>
              {noPermission ? <p className="text-danger">{t("share.option.none")}</p> : null}
              {check.visibility === "private" ? (
                <p className="text-muted-foreground">{t("share.makesUnlisted")}</p>
              ) : null}
            </>
          )}
          <span className="flex gap-2">
            {check.blocked ? null : (
              <Button type="submit" size="sm" disabled={busy || noPermission}>
                {t("share.confirm")}
              </Button>
            )}
            <Button type="button" size="sm" variant="ghost" onClick={() => setCheck(null)}>
              {t("share.cancel")}
            </Button>
          </span>
        </form>
      ) : (
        <Button
          size="sm"
          variant="outline"
          className="w-fit"
          disabled={busy}
          onClick={() => void startCheck()}
        >
          <Link2 />
          {busy ? t("share.checking") : t("share.create")}
        </Button>
      )}

      {shares.length > 0 ? (
        <ul className="divide-border flex flex-col divide-y" data-testid="share-list">
          {shares.map((row) => {
            const state = status(row);
            const permissions = [
              row.allowReading ? t("share.permission.reading") : null,
              row.allowPreview ? t("share.permission.preview") : null,
              row.allowDownload ? t("share.permission.download") : null,
            ].filter(Boolean);
            return (
              <li key={row.id} className="flex flex-col gap-1 py-2" data-testid="share-row">
                <span className="flex flex-wrap items-center gap-2">
                  <Badge variant={state.variant}>{state.text}</Badge>
                  <span>{permissions.join("・")}</span>
                  {row.label ? (
                    <span className="text-muted-foreground break-all">{row.label}</span>
                  ) : null}
                </span>
                <span className="text-muted-foreground text-xs">
                  {[
                    t("share.list.created", { date: formatDateTime(row.createdAt) }),
                    row.expiresAt
                      ? t("share.list.expires", { date: formatDateTime(row.expiresAt) })
                      : t("share.expiry.never"),
                    t("share.list.views", { count: row.accessCount }),
                    row.lastAccessedAt
                      ? t("share.list.lastViewed", { date: formatDateTime(row.lastAccessedAt) })
                      : null,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
                {row.active ? (
                  <Button
                    size="sm"
                    variant={confirming === row.id ? "danger" : "ghost"}
                    className="w-fit"
                    disabled={busy}
                    onClick={() =>
                      confirming === row.id ? void revoke(row.id) : setConfirming(row.id)
                    }
                  >
                    {confirming === row.id ? t("share.revokeConfirm") : t("share.revoke")}
                  </Button>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="text-muted-foreground">{t("share.list.none")}</p>
      )}

      {visibility === "unlisted" ? (
        <Button
          size="sm"
          variant={confirming === "private" ? "danger" : "outline"}
          className="w-fit"
          disabled={busy}
          onClick={() => (confirming === "private" ? void makePrivate() : setConfirming("private"))}
        >
          {confirming === "private" ? t("share.makePrivateConfirm") : t("share.makePrivate")}
        </Button>
      ) : null}

      {error ? (
        <p role="alert" className="text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}
