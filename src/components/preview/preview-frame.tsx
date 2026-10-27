"use client";

import { ExternalLink, RotateCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { t } from "@/lib/i18n";

/**
 * A signed preview URL from POST /api/artifacts/:id/versions/:versionId/preview-token, or from
 * POST /s/:token/preview-token for a share link.
 */
export interface PreviewLink {
  url: string;
  expiresAt: string;
  expiresInSeconds: number;
}

/** A link and its expiry on this browser's clock, which may disagree with the server's. */
interface Issued {
  url: string;
  expiresAtMs: number;
}

/** Refresh the "open in new tab" link this long before its token expires. */
const REFRESH_MARGIN_MS = 60_000;
/** Floor for any scheduled refresh, so no clock or TTL oddity can turn it into a busy loop. */
const MIN_REFRESH_DELAY_MS = 10_000;
const MAX_RETRY_DELAY_MS = 5 * 60_000;

const issue = (link: PreviewLink): Issued => ({
  url: link.url,
  expiresAtMs: Date.now() + link.expiresInSeconds * 1000,
});

/** True once `expiresAtMs` has passed. Flips from a timer, never during render. */
function useExpired(expiresAtMs: number): boolean {
  const [expiredAt, setExpiredAt] = useState<number | null>(null);
  useEffect(() => {
    const timer = setTimeout(
      () => setExpiredAt(expiresAtMs),
      Math.max(0, expiresAtMs - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [expiresAtMs]);
  return expiredAt === expiresAtMs;
}

/**
 * Sandboxed preview of untrusted HTML (docs/SECURITY.md §5.5): served from PREVIEW_ORIGIN and
 * framed with an empty `sandbox` (no scripts, no same-origin, no navigation of the app, no forms,
 * no popups) and no referrer. The frame's URL only changes when the user reloads, so in-frame
 * navigation is never interrupted; once its token expires the user is told to reload. The
 * new-tab link is kept fresh in the background, retrying with backoff when a refresh fails.
 */
export function PreviewFrame({
  mintUrl,
  title,
  initial,
}: {
  /** POST endpoint that issues a fresh `PreviewLink`. */
  mintUrl: string;
  title: string;
  initial: PreviewLink;
}) {
  const [frame, setFrame] = useState(() => issue(initial));
  const [link, setLink] = useState(() => issue(initial));
  const [failures, setFailures] = useState(0);
  const [generation, setGeneration] = useState(0);
  const [reloading, setReloading] = useState(false);
  const [reloadFailed, setReloadFailed] = useState(false);
  const frameExpired = useExpired(frame.expiresAtMs);
  const linkExpired = useExpired(link.expiresAtMs);

  const mint = useCallback(async (): Promise<PreviewLink | null> => {
    try {
      const response = await fetch(mintUrl, { method: "POST" });
      return response.ok ? ((await response.json()) as PreviewLink) : null;
    } catch {
      return null;
    }
  }, [mintUrl]);

  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      const next = await mint();
      if (cancelled) return;
      if (next) {
        setLink(issue(next));
        setFailures(0);
      } else {
        setFailures((count) => count + 1);
      }
    };
    const stale = () => link.expiresAtMs - Date.now() <= REFRESH_MARGIN_MS;
    const delay =
      failures === 0
        ? link.expiresAtMs - Date.now() - REFRESH_MARGIN_MS
        : Math.min(MAX_RETRY_DELAY_MS, 5_000 * 2 ** failures);
    const timer = setTimeout(() => void refresh(), Math.max(MIN_REFRESH_DELAY_MS, delay));
    // Background tabs throttle timers, so also catch up when the page becomes visible again.
    const onVisible = () => {
      if (document.visibilityState === "visible" && failures === 0 && stale()) void refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [link, failures, mint]);

  async function reload() {
    setReloading(true);
    const next = await mint();
    setReloading(false);
    setReloadFailed(!next);
    if (!next) return;
    const fresh = issue(next);
    setFrame(fresh);
    setLink(fresh);
    setFailures(0);
    setGeneration((value) => value + 1);
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-muted-foreground text-xs">{t("preview.isolated")}</p>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={reload} disabled={reloading}>
            <RotateCw className={reloading ? "animate-spin" : undefined} />
            {t("preview.reload")}
          </Button>
          {linkExpired ? null : (
            <Button asChild variant="outline" size="sm">
              <a
                href={link.url}
                target="_blank"
                rel="noopener noreferrer"
                data-testid="preview-open"
              >
                <ExternalLink />
                {t("preview.openInNewTab")}
              </a>
            </Button>
          )}
        </div>
      </div>
      {reloadFailed || frameExpired ? (
        <p role="status" className="text-danger text-sm" data-testid="preview-expired">
          {reloadFailed ? t("preview.reloadFailed") : t("preview.expired")}
        </p>
      ) : null}
      <iframe
        key={generation}
        src={frame.url}
        title={t("preview.frameTitle", { title })}
        sandbox=""
        referrerPolicy="no-referrer"
        className="border-border h-[70vh] min-h-80 w-full rounded-md border bg-white"
        data-testid="preview-frame"
      />
    </div>
  );
}
