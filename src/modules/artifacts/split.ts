import { and, desc, eq, isNull, ne } from "drizzle-orm";
import type { Database, DbExecutor } from "@/infrastructure/database/client";
import {
  artifactFiles,
  artifacts,
  artifactVersions,
  contentChunks,
  extractedDocuments,
  fileAssets,
} from "@/infrastructure/database/schema";
import { AppError, notFound } from "@/lib/errors";
import { isUuid, newId } from "@/lib/ids";
import { recordAudit, type RequestMeta } from "@/modules/audit";
import type { Actor } from "@/modules/auth";
import { filenameStem, summaryFromText } from "@/modules/extraction";
import { indexArtifactMetadata } from "@/modules/search";
import { ARTIFACT_TITLE_MAX } from "./edit";
import { identityKeyFor } from "./identity";

/**
 * Splitting a version off into its own artifact (P1B-VERSION-SPLIT). Imports match versions by
 * filename (IMPORT_PIPELINE §6), and a match can be wrong; this undoes one. The version moves
 * with everything that is its own (files, extractions, derived files, search chunks) to a new
 * artifact made as an import would have made it alone: title, summary and identity key by the
 * import's rules, private, in the old artifact's project and with its sensitivity. What belongs
 * to the old artifact stays with it: notes, tags, collections, reading state, share links, and
 * its other versions with their numbers (a gap is fine; the next import after the newest was
 * split off takes its number again). The import item keeps pointing at the old artifact, as
 * the record of what the import did.
 */

/** The artifact's versions changed between reading them and locking it: start over. */
class VersionsChanged extends Error {}
const ATTEMPTS = 3;

export async function splitVersion(
  db: Database,
  actor: Actor,
  input: { artifactId: string; versionId: string },
  meta: RequestMeta,
) {
  if (!isUuid(input.artifactId) || !isUuid(input.versionId)) throw notFound("Version");
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await db.transaction((tx) => split(tx, actor, input, meta));
    } catch (error) {
      if (!(error instanceof VersionsChanged)) throw error;
      if (attempt === ATTEMPTS) {
        throw new AppError("CONFLICT", "The artifact's versions keep changing; try again", {
          retryable: true,
        });
      }
    }
  }
}

/** The artifact's newest version other than `versionId`, if it has one. */
async function newestOther(tx: DbExecutor, actor: Actor, artifactId: string, versionId: string) {
  const [row] = await tx
    .select({ id: artifactVersions.id })
    .from(artifactVersions)
    .where(
      and(
        eq(artifactVersions.workspaceId, actor.workspaceId),
        eq(artifactVersions.artifactId, artifactId),
        ne(artifactVersions.id, versionId),
      ),
    )
    .orderBy(desc(artifactVersions.versionNumber))
    .limit(1);
  return row?.id ?? null;
}

async function split(
  tx: DbExecutor,
  actor: Actor,
  input: { artifactId: string; versionId: string },
  meta: RequestMeta,
) {
  // Versions before their artifact, as the search index job (`indexVersion`) locks them: the
  // moved one, and the newest remaining one, which becomes current. Pointing the artifact at
  // it takes a key-share lock on it (the foreign key); taken while holding the artifact, that
  // would wait on an index job that holds the version and waits for the artifact. So the
  // remaining version is read first and locked with the moved one, in id order (two splits of
  // one artifact lock the same pair), and checked again once the artifact is locked.
  const next = await newestOther(tx, actor, input.artifactId, input.versionId);
  for (const id of [input.versionId, next].filter((id) => id !== null).sort()) {
    await tx
      .select({ id: artifactVersions.id })
      .from(artifactVersions)
      .where(and(eq(artifactVersions.id, id), eq(artifactVersions.workspaceId, actor.workspaceId)))
      .for(id === input.versionId ? "update" : "key share");
  }
  const [version] = await tx
    .select({
      id: artifactVersions.id,
      artifactId: artifactVersions.artifactId,
      versionNumber: artifactVersions.versionNumber,
      primaryFileId: artifactVersions.primaryFileId,
      activeExtractionId: artifactVersions.activeExtractionId,
    })
    .from(artifactVersions)
    .where(
      and(
        eq(artifactVersions.id, input.versionId),
        eq(artifactVersions.workspaceId, actor.workspaceId),
      ),
    );
  if (!version || version.artifactId !== input.artifactId) throw notFound("Version");
  const [artifact] = await tx
    .select({
      id: artifacts.id,
      projectId: artifacts.projectId,
      sensitivity: artifacts.sensitivity,
      currentVersionId: artifacts.currentVersionId,
    })
    .from(artifacts)
    .where(
      and(
        eq(artifacts.id, version.artifactId),
        eq(artifacts.workspaceId, actor.workspaceId),
        isNull(artifacts.deletedAt),
      ),
    )
    .for("update");
  if (!artifact) throw notFound("Artifact");
  // With the artifact locked, no import adds a version and no other split takes one.
  const newest = await newestOther(tx, actor, artifact.id, version.id);
  if (newest !== next) throw new VersionsChanged();
  if (!newest) {
    throw new AppError("CONFLICT", "An artifact's only version cannot be split off", {
      retryable: false,
    });
  }

  // The name it was imported under: an original's stored name can be an earlier upload's, when
  // the same bytes came in before under another name.
  const [file] = await tx
    .select({ displayName: artifactFiles.displayName, storedName: fileAssets.originalFilename })
    .from(fileAssets)
    .leftJoin(
      artifactFiles,
      and(
        eq(artifactFiles.artifactVersionId, version.id),
        eq(artifactFiles.fileAssetId, fileAssets.id),
        eq(artifactFiles.role, "original"),
      ),
    )
    .where(eq(fileAssets.id, version.primaryFileId))
    .limit(1);
  const filename = file!.displayName ?? file!.storedName;
  const [extraction] = version.activeExtractionId
    ? await tx
        .select({ title: extractedDocuments.title, plainText: extractedDocuments.plainText })
        .from(extractedDocuments)
        .where(eq(extractedDocuments.id, version.activeExtractionId))
    : [];
  const [created] = await tx
    .insert(artifacts)
    .values({
      id: newId(),
      workspaceId: actor.workspaceId,
      projectId: artifact.projectId,
      // A restricted or sensitive work's version is no less so on its own.
      sensitivity: artifact.sensitivity,
      title: (extraction?.title ?? filenameStem(filename)).slice(0, ARTIFACT_TITLE_MAX),
      summary: extraction ? summaryFromText(extraction.plainText, extraction.title) : null,
      identityKey: identityKeyFor(filename),
      currentVersionId: version.id,
      createdBy: actor.userId,
    })
    .returning({ id: artifacts.id, title: artifacts.title });
  await tx
    .update(artifactVersions)
    .set({ artifactId: created!.id, versionNumber: 1 })
    .where(eq(artifactVersions.id, version.id));
  await tx
    .update(contentChunks)
    .set({ artifactId: created!.id })
    .where(eq(contentChunks.artifactVersionId, version.id));
  // If the split version was current, the newest remaining one is; otherwise the current one
  // stays (the update still marks the artifact as changed: it lost a version).
  await tx
    .update(artifacts)
    .set({
      currentVersionId:
        artifact.currentVersionId === version.id ? newest : artifact.currentVersionId,
    })
    .where(eq(artifacts.id, artifact.id));

  // Both metadata documents describe their current version's source.
  await indexArtifactMetadata(tx, artifact.id);
  await indexArtifactMetadata(tx, created!.id);
  await recordAudit(tx, {
    action: "artifact_version.split",
    workspaceId: actor.workspaceId,
    actorUserId: actor.userId,
    targetType: "artifact_version",
    targetId: version.id,
    metadata: {
      fromArtifactId: artifact.id,
      fromVersionNumber: version.versionNumber,
      toArtifactId: created!.id,
    },
    ...meta,
  });
  return { artifact: created! };
}
