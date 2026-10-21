"use client";

import { useRouter } from "next/navigation";
import { type FormEvent, type ReactNode, useState } from "react";
import { jsonRequest } from "@/components/artifacts/api";
import { Button } from "@/components/ui/button";
import { t } from "@/lib/i18n";
import { normalizeLineEndings } from "@/lib/text";

const field =
  "border-border-strong bg-surface focus-visible:ring-ring rounded-md border px-2 py-1.5 text-sm focus-visible:ring-2 focus-visible:outline-none";

const messages = { invalid: t("notes.error.invalid"), gone: t("notes.error.gone") };

function useAction() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function run(action: () => Promise<unknown>, after?: () => void) {
    setBusy(true);
    setError(null);
    try {
      await action();
      after?.();
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("edit.error.generic"));
    } finally {
      setBusy(false);
    }
  }
  return { busy, error, run };
}

function ErrorLine({ error }: { error: string | null }) {
  return error ? (
    <p role="alert" className="text-danger text-sm">
      {error}
    </p>
  ) : null;
}

/** Form for a new note on the artifact. */
export function NewNote({ artifactId }: { artifactId: string }) {
  const { busy, error, run } = useAction();
  const [body, setBody] = useState("");
  function submit(event: FormEvent) {
    event.preventDefault();
    if (!body.trim()) return;
    void run(
      () =>
        jsonRequest(
          `/api/artifacts/${artifactId}/notes`,
          { method: "POST", body: { bodyMarkdown: normalizeLineEndings(body) } },
          messages,
        ),
      () => setBody(""),
    );
  }
  return (
    <form onSubmit={submit} className="flex flex-col gap-2" data-testid="note-create">
      <label className="sr-only" htmlFor="note-body">
        {t("notes.add")}
      </label>
      <textarea
        id="note-body"
        value={body}
        onChange={(event) => setBody(event.target.value)}
        rows={3}
        maxLength={40_000}
        placeholder={t("notes.placeholder")}
        className={field}
      />
      <Button type="submit" size="sm" className="w-fit" disabled={busy || !body.trim()}>
        {t("notes.add")}
      </Button>
      <ErrorLine error={error} />
    </form>
  );
}

/**
 * One note: its rendered body (given as `children`, rendered on the server by the reading
 * mode's allow-list renderer), and for editors, edit and delete.
 */
export function NoteItem({
  note,
  meta,
  canEdit,
  children,
}: {
  note: { id: string; bodyMarkdown: string };
  /** Author and time, already formatted. */
  meta: string;
  canEdit: boolean;
  children: ReactNode;
}) {
  const { busy, error, run } = useAction();
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [body, setBody] = useState(note.bodyMarkdown);

  function save(event: FormEvent) {
    event.preventDefault();
    const text = normalizeLineEndings(body);
    if (text === note.bodyMarkdown) {
      setEditing(false);
      return;
    }
    void run(
      () =>
        jsonRequest(
          `/api/notes/${note.id}`,
          { method: "PATCH", body: { bodyMarkdown: text } },
          messages,
        ),
      () => setEditing(false),
    );
  }

  return (
    <li className="flex flex-col gap-2 py-4" data-testid="note">
      <div className="text-muted-foreground flex flex-wrap items-center gap-2 text-xs">
        <span>{meta}</span>
        {canEdit && !editing ? (
          <span className="ml-auto flex gap-1">
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => setEditing(true)}>
              {t("notes.edit")}
            </Button>
            <Button
              size="sm"
              variant={confirmDelete ? "danger" : "ghost"}
              disabled={busy}
              onClick={() =>
                confirmDelete
                  ? void run(() =>
                      jsonRequest(`/api/notes/${note.id}`, { method: "DELETE" }, messages),
                    )
                  : setConfirmDelete(true)
              }
            >
              {confirmDelete ? t("notes.deleteConfirm") : t("notes.delete")}
            </Button>
          </span>
        ) : null}
      </div>
      {editing ? (
        <form onSubmit={save} className="flex flex-col gap-2">
          <textarea
            value={body}
            onChange={(event) => setBody(event.target.value)}
            rows={5}
            maxLength={40_000}
            aria-label={t("notes.edit")}
            className={field}
          />
          <span className="flex gap-2">
            <Button type="submit" size="sm" disabled={busy || !body.trim()}>
              {t("notes.save")}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => {
                setBody(note.bodyMarkdown);
                setEditing(false);
              }}
            >
              {t("notes.cancel")}
            </Button>
          </span>
        </form>
      ) : (
        <div className="text-sm">{children}</div>
      )}
      <ErrorLine error={error} />
    </li>
  );
}
