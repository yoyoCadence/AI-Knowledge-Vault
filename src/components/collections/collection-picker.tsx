"use client";

import { Plus, X } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";
import { jsonRequest } from "@/components/artifacts/api";
import { Button } from "@/components/ui/button";
import { t } from "@/lib/i18n";

export interface ArtifactCollectionRow {
  id: string;
  name: string;
  /** Names from the top of the tree down to this collection. */
  path: string[];
}

export interface CollectionChoice {
  id: string;
  name: string;
  depth: number;
}

const indent = (depth: number) => "\u3000".repeat(depth);

/**
 * The collections one artifact is in, each shown with its path and linked to the library
 * filtered by it; editors can add the artifact to another collection or take it out.
 */
export function CollectionPicker({
  artifactId,
  collections,
  choices,
  canEdit,
}: {
  artifactId: string;
  collections: ArtifactCollectionRow[];
  choices: CollectionChoice[];
  canEdit: boolean;
}) {
  const router = useRouter();
  const [selected, setSelected] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const memberOf = new Set(collections.map((collection) => collection.id));

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await action();
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("edit.error.generic"));
    } finally {
      setBusy(false);
    }
  }

  function add(event: FormEvent) {
    event.preventDefault();
    if (!selected) return;
    void run(async () => {
      await jsonRequest(
        `/api/collections/${selected}/items/${artifactId}`,
        { method: "PUT" },
        { gone: t("collections.error.gone") },
      );
      setSelected("");
    });
  }

  return (
    <div className="flex flex-col gap-3" data-testid="collection-picker">
      {collections.length > 0 ? (
        <ul className="flex flex-col gap-1.5">
          {collections.map((collection) => (
            <li key={collection.id} className="flex items-center gap-1 text-sm">
              <Link
                href={`/?collection=${collection.id}`}
                className="hover:text-primary min-w-0 break-words"
              >
                {collection.path.join(" / ")}
              </Link>
              {canEdit ? (
                <button
                  type="button"
                  onClick={() =>
                    void run(() =>
                      jsonRequest(
                        `/api/collections/${collection.id}/items/${artifactId}`,
                        { method: "DELETE" },
                        { gone: t("collections.error.gone") },
                      ),
                    )
                  }
                  disabled={busy}
                  aria-label={t("collections.remove", { name: collection.name })}
                  className="text-muted-foreground hover:text-foreground rounded-full p-1 disabled:opacity-50"
                >
                  <X className="size-3" aria-hidden />
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-muted-foreground text-sm">{t("collections.none")}</p>
      )}
      {canEdit && choices.length > 0 ? (
        <form onSubmit={add} className="flex gap-2">
          <label className="sr-only" htmlFor="collection-choice">
            {t("collections.choose")}
          </label>
          <select
            id="collection-choice"
            value={selected}
            onChange={(event) => setSelected(event.target.value)}
            className="border-border-strong bg-surface focus-visible:ring-ring h-8 min-w-0 flex-1 rounded-md border px-2 text-sm focus-visible:ring-2 focus-visible:outline-none"
          >
            <option value="">{t("collections.choose")}</option>
            {choices.map((choice) => (
              <option key={choice.id} value={choice.id} disabled={memberOf.has(choice.id)}>
                {indent(choice.depth) + choice.name}
              </option>
            ))}
          </select>
          <Button type="submit" size="sm" variant="outline" disabled={busy || !selected}>
            <Plus />
            {t("collections.add")}
          </Button>
        </form>
      ) : null}
      {canEdit && choices.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          <Link href="/collections" className="hover:text-primary underline">
            {t("collections.createFirst")}
          </Link>
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-danger text-sm">
          {error}
        </p>
      ) : null}
    </div>
  );
}
