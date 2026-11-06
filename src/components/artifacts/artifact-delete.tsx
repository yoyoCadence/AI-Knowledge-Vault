"use client";

import { Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { t } from "@/lib/i18n";
import { jsonRequest } from "./api";

/**
 * Deletes the artifact (a soft delete, ADR-017). The button opens a line that says what will
 * happen, with its own confirm button (so a double click cannot delete), and then goes to the
 * library, which offers to undo.
 */
export function ArtifactDelete({ artifactId }: { artifactId: string }) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function remove() {
    setBusy(true);
    setError(null);
    try {
      await jsonRequest(
        `/api/artifacts/${artifactId}`,
        { method: "DELETE" },
        { gone: t("delete.error.gone") },
      );
      // Pages already in the client cache (library, this artifact) must not show it again.
      router.refresh();
      router.push(`/?deleted=${artifactId}`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("edit.error.generic"));
      setConfirming(false);
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-3" data-testid="artifact-delete">
      {confirming ? (
        <>
          <p className="text-muted-foreground text-sm">{t("delete.explain")}</p>
          <span className="flex flex-wrap gap-2">
            <Button
              type="button"
              size="sm"
              variant="danger"
              disabled={busy}
              onClick={() => void remove()}
            >
              {t("delete.confirm")}
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
        </>
      ) : (
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="w-fit"
          onClick={() => {
            setError(null);
            setConfirming(true);
          }}
        >
          <Trash2 />
          {t("delete.action")}
        </Button>
      )}
      {error ? (
        <p role="alert" className="text-danger text-sm">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/**
 * Restores a deleted artifact. `open` goes to it afterwards (the undo right after deleting);
 * `stay` refreshes the list it is in.
 */
export function RestoreDeleted({
  artifactId,
  then,
  label,
}: {
  artifactId: string;
  then: "open" | "stay";
  /** Accessible name, e.g. the title, so a list of buttons can be told apart. */
  label?: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function restore() {
    setBusy(true);
    setError(null);
    try {
      await jsonRequest(
        `/api/artifacts/${artifactId}/restore`,
        { method: "POST" },
        { gone: t("deleted.error.gone") },
      );
      router.refresh();
      if (then === "open") router.push(`/artifacts/${artifactId}`);
      else setBusy(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("edit.error.generic"));
      setBusy(false);
    }
  }

  return (
    <span className="flex flex-wrap items-center gap-2">
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={busy}
        aria-label={label}
        onClick={() => void restore()}
      >
        {t("deleted.restore")}
      </Button>
      {error ? (
        <span role="alert" className="text-danger text-sm">
          {error}
        </span>
      ) : null}
    </span>
  );
}
