import { and, eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { closeDb } from "@/infrastructure/database/client";
import { auditLogs, sessions } from "@/infrastructure/database/schema";
import { resetPassword } from "@/modules/auth";
import {
  actorFromCookie,
  authRequest,
  cookieHeaderFrom,
  createTestAdmin,
  signIn,
  signInOk,
  testAuth,
} from "../helpers/auth";
import { closeTestDb, testDb } from "../helpers/db";

/**
 * Passwords (SECURITY.md §6): a change is audited and always signs out every other device;
 * endpoints the app does not use are closed; an operator can reset a forgotten password from
 * the server, signing the owner out everywhere.
 */

const db = testDb();
const NEW_PASSWORD = "a-much-better-passphrase-2026";

afterAll(async () => {
  await closeDb();
  await closeTestDb();
});

const audits = async (userId: string) =>
  (
    await db
      .select({ action: auditLogs.action, metadata: auditLogs.metadata })
      .from(auditLogs)
      .where(and(eq(auditLogs.targetType, "user"), eq(auditLogs.targetId, userId)))
      .orderBy(auditLogs.createdAt)
  ).filter((row) => row.action.startsWith("auth.password"));

const changePassword = (cookie: string, body: Record<string, unknown>) =>
  testAuth().handler(authRequest("/change-password", { cookie, body }));

describe("changing a password", () => {
  it("is audited and signs out every other device, even if the client asks not to", async () => {
    const admin = await createTestAdmin();
    const here = await signInOk(admin.email, admin.password);
    const elsewhere = await signInOk(admin.email, admin.password);

    const response = await changePassword(here.cookie, {
      currentPassword: admin.password,
      newPassword: NEW_PASSWORD,
      revokeOtherSessions: false,
    });
    expect(response.status).toBe(200);

    // The other device is signed out; this one continues with the session it was handed.
    expect(await actorFromCookie(elsewhere.cookie)).toBeNull();
    expect(await actorFromCookie(cookieHeaderFrom(response))).toMatchObject({
      userId: admin.userId,
    });
    expect(
      await db.select({ id: sessions.id }).from(sessions).where(eq(sessions.userId, admin.userId)),
    ).toHaveLength(1);

    expect((await signIn(admin.email, admin.password)).response.status).toBe(401);
    expect((await signIn(admin.email, NEW_PASSWORD)).response.status).toBe(200);
    expect(await audits(admin.userId)).toEqual([
      { action: "auth.password.changed", metadata: { revokedOtherSessions: true } },
    ]);
  });

  it("audits a wrong current password, changes nothing, and needs a session", async () => {
    const admin = await createTestAdmin();
    const { cookie } = await signInOk(admin.email, admin.password);
    const wrong = await changePassword(cookie, {
      currentPassword: "not-the-current-password",
      newPassword: NEW_PASSWORD,
    });
    expect(wrong.status).toBe(400);
    expect(((await wrong.json()) as { code: string }).code).toBe("INVALID_PASSWORD");
    expect((await signIn(admin.email, admin.password)).response.status).toBe(200);
    expect(await audits(admin.userId)).toEqual([
      { action: "auth.password.change_failed", metadata: { code: "INVALID_PASSWORD" } },
    ]);

    const anonymous = await changePassword("", {
      currentPassword: admin.password,
      newPassword: NEW_PASSWORD,
    });
    expect(anonymous.status).toBe(401);
    expect(await audits(admin.userId)).toHaveLength(1);
  });

  it("does not let a session edit the user's name or image (an unused endpoint)", async () => {
    const admin = await createTestAdmin();
    const { cookie } = await signInOk(admin.email, admin.password);
    const response = await testAuth().handler(
      authRequest("/update-user", {
        cookie,
        body: { name: "x", image: "https://tracker.example/pixel.png" },
      }),
    );
    expect(response.status).toBe(404);
  });
});

describe("resetPassword (pnpm admin:reset-password)", () => {
  it("sets the new password, signs the user out everywhere and audits it", async () => {
    const admin = await createTestAdmin();
    const first = await signInOk(admin.email, admin.password);
    const second = await signInOk(admin.email, admin.password);

    const result = await resetPassword(db, {
      email: ` ${admin.email.toUpperCase()} `,
      password: NEW_PASSWORD,
    });
    expect(result).toEqual({ userId: admin.userId, revokedSessions: 2 });
    expect(await actorFromCookie(first.cookie)).toBeNull();
    expect(await actorFromCookie(second.cookie)).toBeNull();
    expect((await signIn(admin.email, admin.password)).response.status).toBe(401);
    expect((await signIn(admin.email, NEW_PASSWORD)).response.status).toBe(200);
    expect(await audits(admin.userId)).toEqual([
      { action: "auth.password.reset", metadata: { via: "cli", revokedSessions: 2 } },
    ]);
  });

  it("refuses an unknown email and a password outside the policy", async () => {
    await expect(
      resetPassword(db, { email: "nobody@example.test", password: NEW_PASSWORD }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    const admin = await createTestAdmin();
    await expect(resetPassword(db, { email: admin.email, password: "short" })).rejects.toThrow();
    expect((await signIn(admin.email, admin.password)).response.status).toBe(200);
  });
});
