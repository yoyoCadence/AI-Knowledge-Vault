"use client";

import { Star } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { jsonRequest } from "@/components/artifacts/api";
import { Button } from "@/components/ui/button";
import { t } from "@/lib/i18n";

type Status = "unread" | "reading" | "read";

interface State {
  status: Status;
  isFavorite: boolean;
}

const STATUSES: Status[] = ["unread", "reading", "read"];

/**
 * The viewer's own reading state of an artifact: favorite and unread / reading / read. Opening
 * the page records it as opened (from the browser, once it is shown: a link prefetch never
 * counts as opening), which moves an unread artifact to "reading".
 */
export function ReadingControls({ artifactId, initial }: { artifactId: string; initial: State }) {
  const [state, setState] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Once the viewer changed something, a late answer to the "opened" request is stale.
  const changed = useRef(false);
  // A change waits for the "opened" request, so the server applies them in the order made
  // (otherwise a slow "opened" could turn a just-chosen "unread" back into "reading").
  const opening = useRef<Promise<unknown>>(Promise.resolve());

  const put = (body: Record<string, unknown>) =>
    jsonRequest<{ readingState: State }>(`/api/artifacts/${artifactId}/reading-state`, {
      method: "PUT",
      body,
    }).then(({ readingState }) => ({
      status: readingState.status,
      isFavorite: readingState.isFavorite,
    }));

  useEffect(() => {
    let shown = true;
    // Best effort: not being able to record the visit must not disturb reading.
    opening.current = jsonRequest<{ readingState: State }>(
      `/api/artifacts/${artifactId}/reading-state`,
      { method: "PUT", body: { opened: true } },
    )
      .then(({ readingState }) => {
        if (shown && !changed.current) {
          setState({ status: readingState.status, isFavorite: readingState.isFavorite });
        }
      })
      .catch(() => undefined);
    return () => {
      shown = false;
    };
  }, [artifactId]);

  async function change(body: Record<string, unknown>) {
    changed.current = true;
    setBusy(true);
    setError(null);
    try {
      await opening.current;
      setState(await put(body));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("edit.error.generic"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="reading-controls">
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={busy}
        aria-pressed={state.isFavorite}
        onClick={() => void change({ isFavorite: !state.isFavorite })}
      >
        <Star className={state.isFavorite ? "fill-warning text-warning" : ""} aria-hidden />
        {state.isFavorite ? t("reading.removeFavorite") : t("reading.addFavorite")}
      </Button>
      <label className="sr-only" htmlFor="reading-status">
        {t("reading.status")}
      </label>
      <select
        id="reading-status"
        value={state.status}
        disabled={busy}
        onChange={(event) => void change({ status: event.target.value })}
        className="border-border-strong bg-surface focus-visible:ring-ring h-8 rounded-md border px-2 text-sm focus-visible:ring-2 focus-visible:outline-none"
      >
        {STATUSES.map((status) => (
          <option key={status} value={status}>
            {t(`reading.status.${status}`)}
          </option>
        ))}
      </select>
      {error ? (
        <p role="alert" className="text-danger w-full text-sm">
          {error}
        </p>
      ) : null}
    </div>
  );
}
