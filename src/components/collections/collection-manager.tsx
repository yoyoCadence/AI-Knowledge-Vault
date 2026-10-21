"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";
import { jsonRequest } from "@/components/artifacts/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { t } from "@/lib/i18n";

export interface CollectionRow {
  id: string;
  parentId: string | null;
  kind: "category" | "collection";
  name: string;
  description: string | null;
  artifactCount: number;
  depth: number;
}

const field =
  "border-border-strong bg-surface focus-visible:ring-ring rounded-md border px-2 py-1.5 text-sm focus-visible:ring-2 focus-visible:outline-none";

const indent = (depth: number) => "\u3000".repeat(depth);

const messages = {
  invalid: t("collections.error.invalid"),
  conflict: t("collections.error.conflict"),
};

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

/** The ids of `id` and everything below it: a collection cannot move under any of them. */
function subtree(rows: CollectionRow[], id: string): Set<string> {
  const ids = new Set([id]);
  // Rows are depth-first, so every descendant comes after its parent.
  for (const row of rows) if (row.parentId && ids.has(row.parentId)) ids.add(row.id);
  return ids;
}

function KindSelect({ name, defaultValue }: { name: string; defaultValue: string }) {
  return (
    <select
      name={name}
      defaultValue={defaultValue}
      className={field}
      aria-label={t("collections.kind")}
    >
      <option value="category">{t("collections.kind.category")}</option>
      <option value="collection">{t("collections.kind.collection")}</option>
    </select>
  );
}

function ParentSelect({
  rows,
  defaultValue,
  exclude,
}: {
  rows: CollectionRow[];
  defaultValue: string;
  exclude?: Set<string>;
}) {
  return (
    <select
      name="parentId"
      defaultValue={defaultValue}
      className={field}
      aria-label={t("collections.parent")}
    >
      <option value="">{t("collections.topLevel")}</option>
      {rows
        .filter((row) => !exclude?.has(row.id))
        .map((row) => (
          <option key={row.id} value={row.id}>
            {indent(row.depth) + row.name}
          </option>
        ))}
    </select>
  );
}

function NewCollection({ rows }: { rows: CollectionRow[] }) {
  const { busy, error, run } = useAction();
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    void run(
      () =>
        jsonRequest(
          "/api/collections",
          {
            method: "POST",
            body: {
              name: String(form.get("name") ?? ""),
              kind: String(form.get("kind") ?? "category"),
              parentId: String(form.get("parentId") ?? "") || null,
              description: String(form.get("description") ?? "") || null,
            },
          },
          messages,
        ),
      () => formElement.reset(),
    );
  }
  return (
    <form onSubmit={submit} className="flex flex-col gap-2" data-testid="collection-create">
      <div className="flex flex-wrap gap-2">
        <label className="sr-only" htmlFor="collection-name">
          {t("collections.newName")}
        </label>
        <input
          id="collection-name"
          name="name"
          required
          maxLength={200}
          placeholder={t("collections.newName")}
          className={`${field} min-w-0 flex-1`}
        />
        <KindSelect name="kind" defaultValue="category" />
        <ParentSelect rows={rows} defaultValue="" />
        <Button type="submit" disabled={busy}>
          {t("collections.create")}
        </Button>
      </div>
      <label className="sr-only" htmlFor="collection-description">
        {t("edit.description")}
      </label>
      <textarea
        id="collection-description"
        name="description"
        rows={2}
        maxLength={4_000}
        placeholder={t("collections.descriptionPlaceholder")}
        className={field}
      />
      {error ? (
        <p role="alert" className="text-danger text-sm">
          {error}
        </p>
      ) : null}
    </form>
  );
}

function CollectionItem({
  row,
  rows,
  canEdit,
}: {
  row: CollectionRow;
  rows: CollectionRow[];
  canEdit: boolean;
}) {
  const { busy, error, run } = useAction();
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const parentId = String(form.get("parentId") ?? "") || null;
    void run(
      () =>
        jsonRequest(
          `/api/collections/${row.id}`,
          {
            method: "PATCH",
            body: {
              name: String(form.get("name") ?? ""),
              kind: String(form.get("kind") ?? row.kind),
              description: String(form.get("description") ?? "") || null,
              // Only a changed parent is a move (a move takes the tree lock).
              ...(parentId !== row.parentId ? { parentId } : {}),
            },
          },
          messages,
        ),
      () => setEditing(false),
    );
  }

  return (
    <li
      className="flex flex-col gap-2 py-3 pr-4"
      style={{ paddingLeft: `${1 + row.depth * 1.5}rem` }}
      data-testid="collection-row"
    >
      <div className="flex flex-wrap items-center gap-3">
        <Link href={`/?collection=${row.id}`} className="hover:text-primary font-medium">
          {row.name}
        </Link>
        <Badge variant="outline">{t(`collections.kind.${row.kind}`)}</Badge>
        <span className="text-muted-foreground text-xs">
          {t("tags.count", { count: row.artifactCount })}
        </span>
        {canEdit ? (
          <span className="ml-auto flex flex-wrap gap-1.5">
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => setEditing(true)}>
              {t("edit.open")}
            </Button>
            <Button
              size="sm"
              variant={confirmDelete ? "danger" : "ghost"}
              disabled={busy}
              onClick={() =>
                confirmDelete
                  ? void run(() =>
                      jsonRequest(
                        `/api/collections/${row.id}`,
                        { method: "DELETE" },
                        { conflict: t("collections.error.hasChildren") },
                      ),
                    )
                  : setConfirmDelete(true)
              }
            >
              {confirmDelete ? t("collections.deleteConfirm") : t("collections.delete")}
            </Button>
          </span>
        ) : null}
      </div>
      {row.description && !editing ? (
        <p className="text-muted-foreground text-sm whitespace-pre-line">{row.description}</p>
      ) : null}
      {editing ? (
        <form onSubmit={save} className="flex flex-col gap-2">
          <div className="flex flex-wrap gap-2">
            <input
              name="name"
              defaultValue={row.name}
              required
              maxLength={200}
              aria-label={t("collections.newName")}
              className={`${field} min-w-0 flex-1`}
            />
            <KindSelect name="kind" defaultValue={row.kind} />
            <ParentSelect
              rows={rows}
              defaultValue={row.parentId ?? ""}
              exclude={subtree(rows, row.id)}
            />
          </div>
          <textarea
            name="description"
            defaultValue={row.description ?? ""}
            rows={2}
            maxLength={4_000}
            aria-label={t("edit.description")}
            className={field}
          />
          <span className="flex gap-2">
            <Button type="submit" size="sm" disabled={busy}>
              {t("edit.save")}
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(false)}>
              {t("edit.cancel")}
            </Button>
          </span>
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

/**
 * The workspace's collection tree: create (at the top or under a parent), rename, describe,
 * change kind, move, delete. Each name links to the library filtered by it, subtree included.
 */
export function CollectionManager({
  collections,
  canEdit,
}: {
  collections: CollectionRow[];
  canEdit: boolean;
}) {
  return (
    <div className="flex flex-col gap-6">
      {canEdit ? <NewCollection rows={collections} /> : null}
      {collections.length > 0 ? (
        <ul className="divide-border border-border bg-surface divide-y rounded-lg border">
          {collections.map((row) => (
            <CollectionItem key={row.id} row={row} rows={collections} canEdit={canEdit} />
          ))}
        </ul>
      ) : (
        <p className="text-muted-foreground text-sm">{t("collections.empty")}</p>
      )}
    </div>
  );
}
