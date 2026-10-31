import type { Metadata } from "next";
import { requirePageActor } from "@/app/_lib/session";
import { ExportPanel, type ExportView } from "@/components/backup/export-panel";
import { IntegrityPanel, type IntegrityView } from "@/components/backup/integrity-panel";
import { RestorePanel, type RestoreView } from "@/components/backup/restore-panel";
import { ImportWorkspace } from "@/components/import/import-workspace";
import { Badge } from "@/components/ui/badge";
import { getEnv } from "@/infrastructure/config/env";
import { getDb } from "@/infrastructure/database/client";
import { formatDateTime } from "@/lib/format";
import { t, tOptional } from "@/lib/i18n";
import { roleAllows } from "@/modules/auth/policy";
import {
  latestIntegrityCheck,
  listExports,
  listRestores,
  toExportDto,
  toIntegrityDto,
  toRestoreDto,
} from "@/modules/backup";
import { ALLOWED_EXTENSIONS, listBatches } from "@/modules/imports";

export const metadata: Metadata = { title: t("nav.importBackup") };

export default async function ImportPage() {
  const actor = await requirePageActor();
  const { items: batches } = await listBatches(getDb(), actor, { limit: 10 });
  const canExport = roleAllows(actor.role, "backup:export");
  // Serialized for the client component (dates become ISO strings).
  const exports: ExportView[] = canExport
    ? JSON.parse(JSON.stringify((await listExports(getDb(), actor)).map(toExportDto)))
    : [];
  const canRestore = roleAllows(actor.role, "backup:restore");
  const [latestRestore] = canRestore ? await listRestores(getDb(), actor, 1) : [];
  const restore: RestoreView | null = latestRestore
    ? JSON.parse(JSON.stringify(toRestoreDto(latestRestore)))
    : null;
  const latestCheck = await latestIntegrityCheck(getDb(), actor);
  const integrity: IntegrityView | null = latestCheck
    ? JSON.parse(JSON.stringify(toIntegrityDto(latestCheck)))
    : null;

  return (
    <div className="flex max-w-4xl flex-col gap-8">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">{t("import.title")}</h1>
        <p className="text-muted-foreground mt-1 text-sm leading-relaxed">{t("import.subtitle")}</p>
      </header>

      <ImportWorkspace
        maxFileBytes={getEnv().IMPORT_MAX_FILE_BYTES}
        allowedExtensions={[...ALLOWED_EXTENSIONS]}
      />

      <section className="flex flex-col gap-3" aria-labelledby="recent-imports">
        <h2 id="recent-imports" className="text-base font-semibold">
          {t("import.recent")}
        </h2>
        {batches.length === 0 ? (
          <p className="text-muted-foreground text-sm">{t("import.recentEmpty")}</p>
        ) : (
          <ul className="surface-panel divide-border divide-y text-sm">
            {batches.map((batch) => (
              <li
                key={batch.id}
                className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5"
              >
                <span>{formatDateTime(batch.createdAt)}</span>
                <span className="text-muted-foreground flex items-center gap-2">
                  {batch.total} 個檔案{batch.failed > 0 ? ` · ${batch.failed} 失敗` : ""}
                  <Badge
                    variant={
                      batch.status === "completed"
                        ? "success"
                        : batch.status === "completed_with_errors"
                          ? "warning"
                          : "neutral"
                    }
                  >
                    {tOptional(`import.batchStatus.${batch.status}`) ?? batch.status}
                  </Badge>
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {canExport ? <ExportPanel initial={exports} /> : null}
      {canRestore ? <RestorePanel initial={restore} /> : null}
      <IntegrityPanel initial={integrity} canRun={canExport} />
    </div>
  );
}
