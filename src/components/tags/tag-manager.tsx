"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";
import { Button } from "@/components/ui/button";
import { t } from "@/lib/i18n";
import { tagRequest } from "./api";

export interface TagRow {
  id: string;
  name: string;
  artifactCount: number;
}

type Mode = { kind: "rename"; name: string } | { kind: "merge"; intoId: string } | null;

/** One tag: link to its artifacts, count, and (for editors) rename, merge into, delete. */
function TagItem({ tag, others, canEdit }: { tag: TagRow; others: TagRow[]; canEdit: boolean }) {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await action();
      setMode(null);
      setConfirmDelete(false);
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("tags.error.generic"));
    } finally {
      setBusy(false);
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (mode?.kind === "rename") {
      void run(() =>
        tagRequest(`/api/tags/${tag.id}`, { method: "PATCH", body: { name: mode.name } }),
      );
    } else if (mode?.kind === "merge" && mode.intoId) {
      void run(() =>
        tagRequest(`/api/tags/${tag.id}/merge`, {
          method: "POST",
          body: { intoTagId: mode.intoId },
        }),
      );
    }
  }

  return (
    <li className="flex flex-col gap-2 px-4 py-3" data-testid="tag-row">
      <div className="flex flex-wrap items-center gap-3">
        <Link href={`/?tag=${tag.id}`} className="hover:text-primary font-medium">
          #{tag.name}
        </Link>
        <span className="text-muted-foreground text-xs">
          {t("tags.count", { count: tag.artifactCount })}
        </span>
        {canEdit ? (
          <span className="ml-auto flex flex-wrap gap-1.5">
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => setMode({ kind: "rename", name: tag.name })}
            >
              {t("tags.rename")}
            </Button>
            {others.length > 0 ? (
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => setMode({ kind: "merge", intoId: "" })}
              >
                {t("tags.merge")}
              </Button>
            ) : null}
            <Button
              size="sm"
              variant={confirmDelete ? "danger" : "ghost"}
              disabled={busy}
              onClick={() =>
                confirmDelete
                  ? void run(() => tagRequest(`/api/tags/${tag.id}`, { method: "DELETE" }))
                  : setConfirmDelete(true)
              }
            >
              {confirmDelete ? t("tags.deleteConfirm") : t("tags.delete")}
            </Button>
          </span>
        ) : null}
      </div>
      {mode ? (
        <form onSubmit={submit} className="flex flex-wrap items-center gap-2">
          {mode.kind === "rename" ? (
            <>
              <label className="sr-only" htmlFor={`rename-${tag.id}`}>
                {t("tags.rename")}
              </label>
              <input
                id={`rename-${tag.id}`}
                value={mode.name}
                maxLength={100}
                onChange={(event) => setMode({ kind: "rename", name: event.target.value })}
                className="border-border-strong bg-surface focus-visible:ring-ring h-8 min-w-0 flex-1 rounded-md border px-2 text-sm focus-visible:ring-2 focus-visible:outline-none"
              />
            </>
          ) : (
            <>
              <label className="text-sm" htmlFor={`merge-${tag.id}`}>
                {t("tags.mergeInto")}
              </label>
              <select
                id={`merge-${tag.id}`}
                value={mode.intoId}
                onChange={(event) => setMode({ kind: "merge", intoId: event.target.value })}
                className="border-border-strong bg-surface h-8 rounded-md border px-2 text-sm"
              >
                <option value="">{t("tags.choose")}</option>
                {others.map((other) => (
                  <option key={other.id} value={other.id}>
                    {other.name}
                  </option>
                ))}
              </select>
            </>
          )}
          <Button
            type="submit"
            size="sm"
            disabled={busy || (mode.kind === "merge" ? !mode.intoId : !mode.name.trim())}
          >
            {t("tags.save")}
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={() => setMode(null)}>
            {t("tags.cancel")}
          </Button>
        </form>
      ) : null}
      {error ? (
        <p role="alert" className="text-danger text-sm">
          {error}
        </p>
      ) : null}
    </li>
  );
}

/** All tags of the workspace (Master Spec §9: organize the library). */
export function TagManager({ tags, canEdit }: { tags: TagRow[]; canEdit: boolean }) {
  return (
    <ul className="divide-border border-border bg-surface divide-y rounded-lg border">
      {tags.map((tag) => (
        <TagItem
          key={tag.id}
          tag={tag}
          others={tags.filter((other) => other.id !== tag.id)}
          canEdit={canEdit}
        />
      ))}
    </ul>
  );
}
