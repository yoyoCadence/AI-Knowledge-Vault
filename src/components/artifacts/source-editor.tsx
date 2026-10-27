"use client";

import { Pencil } from "lucide-react";
import { useRouter } from "next/navigation";
import { type FormEvent, type ReactNode, useState } from "react";
import { Button } from "@/components/ui/button";
import { type MessageKey, t, tOptional } from "@/lib/i18n";
import { jsonRequest } from "./api";

export interface VersionSource {
  sourcePlatform: string | null;
  sourceModel: string | null;
  researchDate: string | null;
  author: string | null;
  sourceUrl: string | null;
}

/** Platforms offered in the picker; an imported value outside this list is kept as is. */
const PLATFORMS = ["claude_design", "claude", "chatgpt", "gemini", "other"] as const;

const field =
  "border-border-strong bg-surface focus-visible:ring-ring w-full rounded-md border px-2 py-1.5 text-sm focus-visible:ring-2 focus-visible:outline-none";

const messages = { invalid: t("source.error.invalid"), gone: t("edit.error.gone") };

/**
 * Where the current version came from (FR-LIB-6). Shows `children` (the read-only fields,
 * rendered on the server); editors can change platform, model, research date, author and source
 * URL. Only changed fields are sent; an emptied field is cleared.
 */
export function SourceEditor({
  artifactId,
  versionId,
  source,
  canEdit,
  children,
}: {
  artifactId: string;
  versionId: string;
  source: VersionSource;
  canEdit: boolean;
  children: ReactNode;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const body: Record<string, string | null> = {};
    for (const key of Object.keys(source) as (keyof VersionSource)[]) {
      const next = String(form.get(key) ?? "").trim();
      if (next !== (source[key] ?? "")) body[key] = next || null;
    }
    if (Object.keys(body).length === 0) {
      setEditing(false);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await jsonRequest(
        `/api/artifacts/${artifactId}/versions/${versionId}`,
        { method: "PATCH", body },
        messages,
      );
      setEditing(false);
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("edit.error.generic"));
    } finally {
      setBusy(false);
    }
  }

  if (!editing) {
    return (
      <div className="flex flex-col gap-3">
        {children}
        {canEdit ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="w-fit"
            onClick={() => {
              setError(null);
              setEditing(true);
            }}
          >
            <Pencil />
            {t("source.edit")}
          </Button>
        ) : null}
      </div>
    );
  }

  const platforms: string[] = [...PLATFORMS];
  if (source.sourcePlatform && !platforms.includes(source.sourcePlatform)) {
    platforms.push(source.sourcePlatform);
  }
  const labelled = (key: MessageKey, input: ReactNode) => (
    <label className="flex flex-col gap-1 text-sm">
      <span className="text-muted-foreground text-xs">{t(key)}</span>
      {input}
    </label>
  );
  return (
    // noValidate: an imported value the browser would refuse (a URL with a space) must not block
    // saving other fields. Only changed fields are sent, and the server validates those.
    <form onSubmit={save} noValidate className="flex flex-col gap-3" data-testid="source-editor">
      {labelled(
        "artifact.sourcePlatform",
        <select name="sourcePlatform" defaultValue={source.sourcePlatform ?? ""} className={field}>
          <option value="">{t("source.unset")}</option>
          {platforms.map((value) => (
            <option key={value} value={value}>
              {tOptional(`platform.${value}`) ?? value}
            </option>
          ))}
        </select>,
      )}
      {labelled(
        "artifact.sourceModel",
        <input
          name="sourceModel"
          defaultValue={source.sourceModel ?? ""}
          maxLength={200}
          className={field}
        />,
      )}
      {labelled(
        "artifact.researchDate",
        <input
          name="researchDate"
          type="date"
          defaultValue={source.researchDate ?? ""}
          className={field}
        />,
      )}
      {labelled(
        "artifact.author",
        <input
          name="author"
          defaultValue={source.author ?? ""}
          maxLength={200}
          className={field}
        />,
      )}
      {labelled(
        "artifact.sourceUrl",
        <input
          name="sourceUrl"
          type="url"
          defaultValue={source.sourceUrl ?? ""}
          maxLength={2_048}
          placeholder="https://"
          className={field}
        />,
      )}
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={busy}>
          {t("edit.save")}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={() => {
            setError(null);
            setEditing(false);
          }}
        >
          {t("edit.cancel")}
        </Button>
      </div>
      {error ? (
        <p role="alert" className="text-danger text-sm">
          {error}
        </p>
      ) : null}
    </form>
  );
}
