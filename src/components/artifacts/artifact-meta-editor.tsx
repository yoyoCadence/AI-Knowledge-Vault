"use client";

import { Pencil } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";
import { Button } from "@/components/ui/button";
import { t } from "@/lib/i18n";
import { normalizeLineEndings } from "@/lib/text";
import { jsonRequest } from "./api";

export interface ProjectOption {
  id: string;
  title: string;
}

const field =
  "border-border-strong bg-surface focus-visible:ring-ring w-full rounded-md border px-2 py-1.5 text-sm focus-visible:ring-2 focus-visible:outline-none";

/**
 * The artifact's own information: its research project (a link to the library filtered by
 * it) and its description; editors can change title, description and project. Originals and
 * versions are never touched.
 */
export function ArtifactMetaEditor({
  artifactId,
  title,
  description,
  project,
  projects,
  canEdit,
}: {
  artifactId: string;
  title: string;
  description: string | null;
  project: ProjectOption | null;
  projects: ProjectOption[];
  canEdit: boolean;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const nextTitle = String(form.get("title") ?? "");
    const nextDescription = String(form.get("description") ?? "");
    const nextProject = String(form.get("projectId") ?? "");
    const body: Record<string, unknown> = {};
    if (nextTitle !== title) body.title = nextTitle;
    // Compared as the server stores it, so an untouched description is never re-sent.
    const same = (a: string, b: string) =>
      normalizeLineEndings(a).trim() === normalizeLineEndings(b).trim();
    if (!same(nextDescription, description ?? "")) body.description = nextDescription || null;
    if (nextProject !== (project?.id ?? "")) body.projectId = nextProject || null;
    if (Object.keys(body).length === 0) {
      setEditing(false);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await jsonRequest(`/api/artifacts/${artifactId}`, { method: "PATCH", body });
      setEditing(false);
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("edit.error.generic"));
    } finally {
      setBusy(false);
    }
  }

  if (editing) {
    return (
      <form onSubmit={save} className="flex flex-col gap-3" data-testid="meta-editor">
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted-foreground text-xs">{t("edit.title")}</span>
          <input name="title" defaultValue={title} maxLength={1_000} required className={field} />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted-foreground text-xs">{t("edit.description")}</span>
          <textarea
            name="description"
            defaultValue={description ?? ""}
            rows={4}
            maxLength={10_000}
            className={field}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted-foreground text-xs">{t("projects.label")}</span>
          <select name="projectId" defaultValue={project?.id ?? ""} className={field}>
            <option value="">{t("projects.none")}</option>
            {projects.map((option) => (
              <option key={option.id} value={option.id}>
                {option.title}
              </option>
            ))}
          </select>
        </label>
        <div className="flex gap-2">
          <Button type="submit" size="sm" disabled={busy}>
            {t("edit.save")}
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(false)}>
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

  return (
    <div className="flex flex-col gap-3 text-sm" data-testid="artifact-meta">
      <div className="flex flex-col gap-0.5">
        <span className="text-muted-foreground text-xs">{t("projects.label")}</span>
        {project ? (
          <Link
            href={`/?project=${project.id}`}
            className="hover:text-primary font-medium break-words"
          >
            {project.title}
          </Link>
        ) : (
          <span className="text-muted-foreground">{t("projects.none")}</span>
        )}
      </div>
      {description ? <p className="leading-relaxed whitespace-pre-line">{description}</p> : null}
      {canEdit ? (
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="w-fit"
          onClick={() => setEditing(true)}
        >
          <Pencil />
          {t("edit.open")}
        </Button>
      ) : null}
    </div>
  );
}
