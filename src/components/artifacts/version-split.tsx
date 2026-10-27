"use client";

import { Scissors } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { t } from "@/lib/i18n";
import { jsonRequest } from "./api";

const messages = { conflict: t("split.error.only"), gone: t("edit.error.gone") };

/**
 * Splits a version off into an artifact of its own (a wrong filename match undone). The scissors
 * open a line that says what will happen, with its own confirm button (so a double-click cannot
 * split), which splits and opens the new artifact. Rendered inside the version's list row, which
 * wraps that line onto a row of its own.
 */
export function VersionSplit({
  artifactId,
  versionId,
  versionNumber,
  current,
}: {
  artifactId: string;
  versionId: string;
  versionNumber: number;
  /** The artifact's current version: once it is split off, an earlier one is shown instead. */
  current: boolean;
}) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function split() {
    setBusy(true);
    setError(null);
    try {
      const { artifact } = await jsonRequest<{ artifact: { id: string } }>(
        `/api/artifacts/${artifactId}/versions/${versionId}/split`,
        { method: "POST" },
        messages,
      );
      // The old artifact's page changed too: going back must not show the moved version.
      router.refresh();
      router.push(`/artifacts/${artifact.id}`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("edit.error.generic"));
      setConfirming(false);
      setBusy(false);
    }
  }

  const label = `${t("split.action")} V${versionNumber}`;
  return (
    <>
      <Button
        type="button"
        size="icon"
        variant="ghost"
        disabled={busy || confirming}
        aria-label={label}
        title={label}
        onClick={() => {
          setError(null);
          setConfirming(true);
        }}
      >
        <Scissors />
      </Button>
      {confirming ? (
        <span className="flex basis-full flex-wrap items-center gap-2">
          <span className="text-muted-foreground min-w-0 flex-1 basis-48 text-xs">
            {t("split.explain", { number: versionNumber })}
            {current ? ` ${t("split.explainCurrent")}` : null}
          </span>
          <Button
            type="button"
            size="sm"
            variant="danger"
            disabled={busy}
            onClick={() => void split()}
          >
            {t("split.confirm", { number: versionNumber })}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => setConfirming(false)}
          >
            {t("edit.cancel")}
          </Button>
        </span>
      ) : null}
      {error ? (
        <p role="alert" className="text-danger basis-full text-xs">
          {error}
        </p>
      ) : null}
    </>
  );
}
