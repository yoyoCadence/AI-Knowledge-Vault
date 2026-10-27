import { and, desc, eq, isNull, ne } from "drizzle-orm";
import type { Database } from "@/infrastructure/database/client";
import {
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
 * import's rules, private, in the old artifact's project. What belongs to the old artifact stays
 * with it: notes, tags, collections, reading state, share links, and its other versions with
 * their numbers (a gap is fine). The import item keeps pointing at the old artifact, as the
 * record of what the import did.
 */
export async function splitVersion(
  db: Database,
  actor: Actor,
  input: { artifactId: string; versionId: string },
  meta: RequestMeta,
) {
  if (!isUuid(input.artifactId) || !isUuid(input.versionId)) throw notFound("Version");
  return db.transaction(async (tx) => {
    // The version, then its artifact: the order the search index job (`indexVersion`) takes.
    // A job for this version that runs after the split reads its new artifact and locks that.
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
      )
      .for("update");
    if (!version || version.artifactId !== input.artifactId) throw notFound("Version");
    const [artifact] = await tx
      .select({ id: artifacts.id, projectId: artifacts.projectId })
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
    const [newest] = await tx
      .select({ id: artifactVersions.id })
      .from(artifactVersions)
      .where(and(eq(artifactVersions.artifactId, artifact.id), ne(artifactVersions.id, version.id)))
      .orderBy(desc(artifactVersions.versionNumber))
      .limit(1);
    if (!newest) {
      throw new AppError("CONFLICT", "An artifact's only version cannot be split off", {
        retryable: false,
      });
    }

    const [file] = await tx
      .select({ originalFilename: fileAssets.originalFilename })
      .from(fileAssets)
      .where(eq(fileAssets.id, version.primaryFileId));
    const [extraction] = version.activeExtractionId
      ? await tx
          .select({ title: extractedDocuments.title, plainText: extractedDocuments.plainText })
          .from(extractedDocuments)
          .where(eq(extractedDocuments.id, version.activeExtractionId))
      : [];
    const filename = file!.originalFilename;
    const [created] = await tx
      .insert(artifacts)
      .values({
        id: newId(),
        workspaceId: actor.workspaceId,
        projectId: artifact.projectId,
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
    // The newest remaining version is current; it already was unless the split one was.
    await tx
      .update(artifacts)
      .set({ currentVersionId: newest.id })
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
  });
}
