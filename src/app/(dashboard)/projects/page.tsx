import type { Metadata } from "next";
import { requirePageActor } from "@/app/_lib/session";
import { ProjectManager } from "@/components/projects/project-manager";
import { getDb } from "@/infrastructure/database/client";
import { t } from "@/lib/i18n";
import { roleAllows } from "@/modules/auth";
import { listProjects } from "@/modules/projects";

export const metadata: Metadata = { title: t("nav.projects") };

export default async function ProjectsPage() {
  const actor = await requirePageActor();
  const projects = await listProjects(getDb(), actor);
  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">{t("projects.title")}</h1>
        <p className="text-muted-foreground mt-1 text-sm">{t("projects.description")}</p>
      </header>
      <ProjectManager
        projects={projects.map((project) => ({
          id: project.id,
          title: project.title,
          description: project.description,
          status: project.status,
          artifactCount: project.artifactCount,
        }))}
        canEdit={roleAllows(actor.role, "library:write")}
      />
    </div>
  );
}
