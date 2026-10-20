import { hashPassword } from "better-auth/crypto";
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "@/infrastructure/database/client";
import {
  authAccounts,
  users,
  workspaceMembers,
  workspaces,
} from "@/infrastructure/database/schema";
import { AppError } from "@/lib/errors";
import { newId } from "@/lib/ids";
import { recordAudit } from "@/modules/audit";
import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from "./auth";

/**
 * Server-side admin bootstrap (FR-AUTH-1). Never exposed over HTTP; run via `pnpm admin:create`.
 * Creates user + credential account + personal workspace + owner membership atomically.
 */
export const AdminInput = z.object({
  email: z.email().transform((value) => value.trim().toLowerCase()),
  name: z.string().trim().min(1).max(100),
  password: z.string().min(MIN_PASSWORD_LENGTH).max(MAX_PASSWORD_LENGTH),
  workspaceName: z.string().trim().min(1).max(100).optional(),
});
export type AdminInput = z.input<typeof AdminInput>;

export function slugify(value: string): string {
  const slug = value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return slug || "vault";
}

export async function createAdmin(
  db: Database,
  input: AdminInput,
): Promise<{ userId: string; workspaceId: string; workspaceSlug: string }> {
  const parsed = AdminInput.parse(input);
  const passwordHash = await hashPassword(parsed.password);

  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, parsed.email));
    if (existing) throw new AppError("CONFLICT", "A user with this email already exists");

    const userId = newId();
    await tx
      .insert(users)
      .values({ id: userId, email: parsed.email, name: parsed.name, emailVerified: true });
    // Better Auth's credential provider stores the scrypt hash on the account row (accountId = userId).
    await tx.insert(authAccounts).values({
      accountId: userId,
      providerId: "credential",
      userId,
      password: passwordHash,
    });

    const baseSlug = slugify(parsed.email.split("@")[0] ?? "vault");
    let workspaceSlug = baseSlug;
    for (let attempt = 2; ; attempt += 1) {
      const [taken] = await tx
        .select({ id: workspaces.id })
        .from(workspaces)
        .where(eq(workspaces.slug, workspaceSlug));
      if (!taken) break;
      workspaceSlug = `${baseSlug}-${attempt}`;
    }
    const workspaceId = newId();
    await tx.insert(workspaces).values({
      id: workspaceId,
      name: parsed.workspaceName ?? `${parsed.name} 的知識庫`,
      slug: workspaceSlug,
    });
    await tx.insert(workspaceMembers).values({ workspaceId, userId, role: "owner" });
    await recordAudit(tx, {
      action: "admin.created",
      workspaceId,
      actorUserId: userId,
      targetType: "user",
      targetId: userId,
      metadata: { via: "cli" },
    });
    return { userId, workspaceId, workspaceSlug };
  });
}
