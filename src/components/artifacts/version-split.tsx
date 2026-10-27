"use client";

import { Scissors } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { t } from "@/lib/i18n";
import { jsonRequest } from "./api";

const messages = { conflict: t("split.error.only"), gone: t("edit.error.gone") };

/**
 * Splits a version off into an artifact of its own (a wrong filename match undone): the first
 * press says what will happen, the second does it and opens the new artifact. Rendered inside
 * the version's list row, which wraps the explanation onto a line of its own.
 */
export function VersionSplit({
  artifactId,
  versionId,
  versionNumber,
}: {
  artifactId: string;
  versionId: string;
  versionNumber: number;
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
        size={confirming ? "sm" : "icon"}
        variant={confirming ? "danger" : "ghost"}
        disabled={busy}
        aria-label={confirming ? undefined : label}
        title={confirming ? undefined : label}
        onClick={() => (confirming ? void split() : setConfirming(true))}
      >
        <Scissors />
        {confirming ? t("split.confirm") : null}
      </Button>
      {confirming ? (
        <span className="flex basis-full flex-wrap items-center gap-2">
          <span className="text-muted-foreground min-w-0 flex-1 text-xs">
            {t("split.explain", { number: versionNumber })}
          </span>
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
