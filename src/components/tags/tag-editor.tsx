"use client";

import { Plus, X } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";
import { Button } from "@/components/ui/button";
import { t } from "@/lib/i18n";
import { tagRequest } from "./api";

export interface TagOption {
  id: string;
  name: string;
}

/**
 * The tags of one artifact. Each links to the library filtered by it; editors can add a tag
 * by name (an existing tag of the same name is reused) and remove one.
 */
export function TagEditor({
  artifactId,
  tags,
  allTags,
  canEdit,
}: {
  artifactId: string;
  tags: TagOption[];
  allTags: TagOption[];
  canEdit: boolean;
}) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const suggestions = allTags.filter((tag) => !tags.some((own) => own.id === tag.id));

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await action();
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("tags.error.generic"));
    } finally {
      setBusy(false);
    }
  }

  function add(event: FormEvent) {
    event.preventDefault();
    const value = name.trim();
    if (!value) return;
    void run(async () => {
      const { tag } = await tagRequest<{ tag: TagOption }>("/api/tags", {
        method: "POST",
        body: { name: value },
      });
      await tagRequest(`/api/artifacts/${artifactId}/tags/${tag.id}`, { method: "PUT" });
      setName("");
    });
  }

  function remove(tag: TagOption) {
    void run(async () => {
      await tagRequest(`/api/artifacts/${artifactId}/tags/${tag.id}`, { method: "DELETE" });
    });
  }

  return (
    <div className="flex flex-col gap-3" data-testid="tag-editor">
      {tags.length > 0 ? (
        <ul className="flex flex-wrap gap-1.5">
          {tags.map((tag) => (
            <li
              key={tag.id}
              className="border-border bg-surface-muted inline-flex items-center rounded-full border text-xs"
            >
              <Link href={`/?tag=${tag.id}`} className="hover:text-primary py-0.5 pr-1 pl-2.5">
                #{tag.name}
              </Link>
              {canEdit ? (
                <button
                  type="button"
                  onClick={() => remove(tag)}
                  disabled={busy}
                  aria-label={t("tags.remove", { name: tag.name })}
                  className="text-muted-foreground hover:text-foreground rounded-full p-1 disabled:opacity-50"
                >
                  <X className="size-3" aria-hidden />
                </button>
              ) : (
                <span className="pr-1.5" />
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-muted-foreground text-sm">{t("tags.none")}</p>
      )}
      {canEdit ? (
        <form onSubmit={add} className="flex gap-2">
          <label className="sr-only" htmlFor="tag-name">
            {t("tags.add")}
          </label>
          <input
            id="tag-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            list="tag-suggestions"
            maxLength={50}
            placeholder={t("tags.placeholder")}
            className="border-border-strong bg-surface focus-visible:ring-ring h-8 min-w-0 flex-1 rounded-md border px-2 text-sm focus-visible:ring-2 focus-visible:outline-none"
          />
          <datalist id="tag-suggestions">
            {suggestions.map((tag) => (
              <option key={tag.id} value={tag.name} />
            ))}
          </datalist>
          <Button type="submit" size="sm" variant="outline" disabled={busy || !name.trim()}>
            <Plus />
            {t("tags.add")}
          </Button>
        </form>
      ) : null}
      {error ? (
        <p role="alert" className="text-danger text-sm">
          {error}
        </p>
      ) : null}
    </div>
  );
}
