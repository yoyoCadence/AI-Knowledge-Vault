"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";
import { jsonRequest } from "@/components/artifacts/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { t } from "@/lib/i18n";

export interface ProjectRow {
  id: string;
  title: string;
  description: string | null;
  status: "active" | "archived";
  artifactCount: number;
}

const field =
  "max-w-full min-w-0 border-border-strong bg-surface focus-visible:ring-ring rounded-md border px-2 py-1.5 text-sm focus-visible:ring-2 focus-visible:outline-none";

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

function NewProject() {
  const { busy, error, run } = useAction();
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    void run(
      () =>
        jsonRequest(
          "/api/projects",
          {
            method: "POST",
            body: {
              title: String(form.get("title") ?? ""),
              description: String(form.get("description") ?? "") || null,
            },
          },
          { invalid: t("projects.error.invalid") },
        ),
      () => formElement.reset(),
    );
  }
  return (
    <form onSubmit={submit} className="flex flex-col gap-2" data-testid="project-create">
      <div className="flex flex-wrap gap-2">
        <label className="sr-only" htmlFor="project-title">
          {t("projects.newTitle")}
        </label>
        <input
          id="project-title"
          name="title"
          required
          maxLength={400}
          placeholder={t("projects.newTitle")}
          className={`${field} min-w-0 flex-1`}
        />
        <Button type="submit" disabled={busy}>
          {t("projects.create")}
        </Button>
      </div>
      <label className="sr-only" htmlFor="project-description">
        {t("edit.description")}
      </label>
      <textarea
        id="project-description"
        name="description"
        rows={2}
        maxLength={4_000}
        placeholder={t("projects.descriptionPlaceholder")}
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

function ProjectItem({ project, canEdit }: { project: ProjectRow; canEdit: boolean }) {
  const { busy, error, run } = useAction();
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const patch = (body: Record<string, unknown>) =>
    jsonRequest(
      `/api/projects/${project.id}`,
      { method: "PATCH", body },
      { invalid: t("projects.error.invalid") },
    );

  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    void run(
      () =>
        patch({
          title: String(form.get("title") ?? ""),
          description: String(form.get("description") ?? "") || null,
        }),
      () => setEditing(false),
    );
  }

  return (
    <li className="flex flex-col gap-2 px-4 py-3" data-testid="project-row">
      <div className="flex flex-wrap items-center gap-3">
        <Link
          href={`/?project=${project.id}`}
          className="hover:text-primary min-w-0 font-medium break-words"
        >
          {project.title}
        </Link>
        {project.status === "archived" ? (
          <Badge variant="outline">{t("projects.archived")}</Badge>
        ) : null}
        <span className="text-muted-foreground text-xs">
          {t("tags.count", { count: project.artifactCount })}
        </span>
        {canEdit ? (
          <span className="ml-auto flex flex-wrap gap-1.5">
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => setEditing(true)}>
              {t("edit.open")}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() =>
                void run(() =>
                  patch({ status: project.status === "active" ? "archived" : "active" }),
                )
              }
            >
              {project.status === "active" ? t("projects.archive") : t("projects.unarchive")}
            </Button>
            <Button
              size="sm"
              variant={confirmDelete ? "danger" : "ghost"}
              disabled={busy}
              onClick={() =>
                confirmDelete
                  ? void run(() => jsonRequest(`/api/projects/${project.id}`, { method: "DELETE" }))
                  : setConfirmDelete(true)
              }
            >
              {confirmDelete ? t("projects.deleteConfirm") : t("projects.delete")}
            </Button>
          </span>
        ) : null}
      </div>
      {project.description && !editing ? (
        <p className="text-muted-foreground text-sm whitespace-pre-line">{project.description}</p>
      ) : null}
      {editing ? (
        <form onSubmit={save} className="flex flex-col gap-2">
          <input
            name="title"
            defaultValue={project.title}
            required
            maxLength={400}
            aria-label={t("projects.newTitle")}
            className={field}
          />
          <textarea
            name="description"
            defaultValue={project.description ?? ""}
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

/** The workspace's research projects: create, rename, describe, archive, delete. */
export function ProjectManager({
  projects,
  canEdit,
}: {
  projects: ProjectRow[];
  canEdit: boolean;
}) {
  return (
    <div className="flex flex-col gap-6">
      {canEdit ? <NewProject /> : null}
      {projects.length > 0 ? (
        <ul className="surface-panel divide-border divide-y">
          {projects.map((project) => (
            <ProjectItem key={project.id} project={project} canEdit={canEdit} />
          ))}
        </ul>
      ) : (
        <p className="text-muted-foreground text-sm">{t("projects.empty")}</p>
      )}
    </div>
  );
}
