import { and, eq, isNull } from "drizzle-orm";
import type { DbExecutor } from "@/infrastructure/database/client";
import { artifacts, derivedAssets } from "@/infrastructure/database/schema";
import { notFound } from "@/lib/errors";
import type { Actor } from "@/modules/auth";

/**
 * Resolves the current version's thumbnail for an artifact the actor may see. Thumbnails are
 * WebP images re-encoded by our own pipeline (never the uploaded bytes), so they are safe to
 * serve from the app origin.
 */
export async function getThumbnailForActor(db: DbExecutor, actor: Actor, artifactId: string) {
  const [row] = await db
    .select({
      storageKey: derivedAssets.storageKey,
      mimeType: derivedAssets.mimeType,
      sha256: derivedAssets.sha256,
    })
    .from(artifacts)
    .innerJoin(
      derivedAssets,
      and(
        eq(derivedAssets.artifactVersionId, artifacts.currentVersionId),
        eq(derivedAssets.kind, "thumbnail"),
      ),
    )
    .where(
      and(
        eq(artifacts.id, artifactId),
        eq(artifacts.workspaceId, actor.workspaceId),
        isNull(artifacts.deletedAt),
      ),
    );
  if (!row) throw notFound("Thumbnail");
  return row;
}
