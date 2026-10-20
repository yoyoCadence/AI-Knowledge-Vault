import { and, desc, eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import {
  auditLogs,
  authAccounts,
  sessions,
  users,
  workspaceMembers,
  workspaces,
} from "@/infrastructure/database/schema";
import { AppError } from "@/lib/errors";
import {
  createAdmin,
  hashEmailForAudit,
  listActiveSessions,
  revokeOtherSessions,
  revokeSession,
} from "@/modules/auth";
import {
  actorFromCookie,
  authRequest,
  createTestAdmin,
  signIn,
  testAuth,
  TEST_PASSWORD,
  uniqueIp,
} from "../helpers/auth";
import { closeTestDb, testDb } from "../helpers/db";

const db = testDb();
const meta = { ipAddress: "127.0.0.1", userAgent: "vitest" };

afterAll(async () => {
  await closeTestDb();
});

describe("admin bootstrap (admin:create)", () => {
  it("creates user, credential account, workspace and owner membership atomically", async () => {
    const admin = await createTestAdmin();
    const [user] = await db.select().from(users).where(eq(users.id, admin.userId));
    expect(user).toMatchObject({ email: admin.email, emailVerified: true });

    const [account] = await db
      .select()
      .from(authAccounts)
      .where(eq(authAccounts.userId, admin.userId));
    expect(account).toMatchObject({ providerId: "credential", accountId: admin.userId });
    expect(account?.password).toBeTruthy();
    expect(account?.password).not.toContain(TEST_PASSWORD);

    const [workspace] = await db
      .select()
      .from(workspaces)
      .where(eq(workspaces.id, admin.workspaceId));
    expect(workspace?.slug).toBe(admin.workspaceSlug);
    const [member] = await db
      .select()
      .from(workspaceMembers)
      .where(eq(workspaceMembers.userId, admin.userId));
    expect(member).toMatchObject({ workspaceId: admin.workspaceId, role: "owner" });
  });

  it("refuses duplicate emails (case-insensitive) and short passwords", async () => {
    const admin = await createTestAdmin();
    await expect(
      createAdmin(db, { email: admin.email.toUpperCase(), name: "Dup", password: TEST_PASSWORD }),
    ).rejects.toSatisfy((error: unknown) => error instanceof AppError && error.code === "CONFLICT");
    await expect(
      createAdmin(db, { email: "short@example.test", name: "S", password: "short" }),
    ).rejects.toThrow();
  });
});

describe("email + password sign-in", () => {
  it("issues an HttpOnly session cookie and resolves an owner actor", async () => {
    const admin = await createTestAdmin();
    const { response, cookie } = await signIn(admin.email, admin.password);
    expect(response.status).toBe(200);

    const setCookie = response.headers
      .getSetCookie()
      .find((value) => value.startsWith("vault.session_token="));
    expect(setCookie).toBeDefined();
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=Lax/i);

    const actor = await actorFromCookie(cookie);
    expect(actor).toMatchObject({
      userId: admin.userId,
      workspaceId: admin.workspaceId,
      role: "owner",
      email: admin.email,
    });

    const [audit] = await db
      .select()
      .from(auditLogs)
      .where(
        and(eq(auditLogs.action, "auth.login.succeeded"), eq(auditLogs.actorUserId, admin.userId)),
      );
    expect(audit).toBeDefined();
  });

  it("rejects wrong passwords and audits the failure without storing the raw email", async () => {
    const admin = await createTestAdmin();
    const { response, cookie } = await signIn(admin.email, "definitely the wrong password");
    expect(response.status).toBe(401);
    expect(cookie).not.toContain("vault.session_token=");

    const failures = await db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, "auth.login.failed"))
      .orderBy(desc(auditLogs.createdAt))
      .limit(20);
    const mine = failures.find((row) => row.metadata.emailHash === hashEmailForAudit(admin.email));
    expect(mine).toBeDefined();
    expect(JSON.stringify(mine)).not.toContain(admin.email);
  });

  it("does not expose public sign-up", async () => {
    const email = "intruder@example.test";
    const response = await testAuth().handler(
      authRequest("/sign-up/email", { body: { email, password: TEST_PASSWORD, name: "Intruder" } }),
    );
    expect(response.status).toBe(404);
    expect(await db.select().from(users).where(eq(users.email, email))).toHaveLength(0);
  });

  it("rate limits sign-in attempts per client (5 per minute)", async () => {
    const admin = await createTestAdmin();
    const ip = uniqueIp();
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 7; attempt += 1) {
      const { response } = await signIn(admin.email, "wrong password attempt", ip);
      statuses.push(response.status);
    }
    expect(statuses.slice(0, 5).every((status) => status === 401)).toBe(true);
    expect(statuses.at(-1)).toBe(429);

    // A different client is unaffected.
    const { response } = await signIn(admin.email, admin.password, uniqueIp());
    expect(response.status).toBe(200);
  });

  it("does not serve Better Auth's token-bearing session endpoints", async () => {
    const admin = await createTestAdmin();
    const { cookie } = await signIn(admin.email, admin.password);
    for (const [path, method] of [
      ["/get-session", "GET"],
      ["/list-sessions", "GET"],
      ["/revoke-session", "POST"],
      ["/revoke-sessions", "POST"],
      ["/revoke-other-sessions", "POST"],
    ] as const) {
      const response = await testAuth().handler(
        authRequest(path, { method, cookie, body: method === "POST" ? {} : undefined }),
      );
      expect(response.status, path).toBe(404);
    }
    // The session itself is unaffected.
    expect(await actorFromCookie(cookie)).not.toBeNull();
  });

  it("audits the resolved client address, never a forged leftmost X-Forwarded-For entry", async () => {
    const admin = await createTestAdmin();
    const { response } = await signIn(admin.email, admin.password, "198.51.100.66, 203.0.113.7");
    expect(response.status).toBe(200);
    const [audit] = await db
      .select()
      .from(auditLogs)
      .where(
        and(eq(auditLogs.action, "auth.login.succeeded"), eq(auditLogs.actorUserId, admin.userId)),
      );
    expect(audit).toBeDefined();
    expect(audit!.ipAddress).toBeNull();
  });

  it("anonymous requests resolve to no actor", async () => {
    expect(await actorFromCookie("")).toBeNull();
    expect(await actorFromCookie("vault.session_token=forged.value")).toBeNull();
  });

  it("sign-out invalidates the session", async () => {
    const admin = await createTestAdmin();
    const { cookie } = await signIn(admin.email, admin.password);
    expect(await actorFromCookie(cookie)).not.toBeNull();
    const response = await testAuth().handler(authRequest("/sign-out", { body: {}, cookie }));
    expect(response.status).toBe(200);
    expect(await actorFromCookie(cookie)).toBeNull();
  });
});

describe("session management", () => {
  it("lists sessions without tokens and revokes a specific one", async () => {
    const admin = await createTestAdmin();
    const first = await signIn(admin.email, admin.password);
    const second = await signIn(admin.email, admin.password);
    const actor = (await actorFromCookie(first.cookie))!;

    const listed = await listActiveSessions(db, actor);
    expect(listed).toHaveLength(2);
    expect(listed.filter((session) => session.current)).toHaveLength(1);
    expect(JSON.stringify(listed)).not.toMatch(/token/i);

    const other = listed.find((session) => !session.current)!;
    expect(await revokeSession(db, actor, other.id, meta)).toBe(true);
    expect(await actorFromCookie(second.cookie)).toBeNull();
    expect(await actorFromCookie(first.cookie)).not.toBeNull();
  });

  it("cannot revoke another user's session", async () => {
    const alice = await createTestAdmin();
    const bob = await createTestAdmin();
    const aliceLogin = await signIn(alice.email, alice.password);
    const bobLogin = await signIn(bob.email, bob.password);
    const aliceActor = (await actorFromCookie(aliceLogin.cookie))!;
    const bobActor = (await actorFromCookie(bobLogin.cookie))!;

    expect(await revokeSession(db, aliceActor, bobActor.sessionId, meta)).toBe(false);
    expect(await actorFromCookie(bobLogin.cookie)).not.toBeNull();
  });

  it("revokes all other sessions but keeps the current one", async () => {
    const admin = await createTestAdmin();
    const logins = [];
    for (let index = 0; index < 3; index += 1)
      logins.push(await signIn(admin.email, admin.password));
    const actor = (await actorFromCookie(logins[0]!.cookie))!;

    expect(await revokeOtherSessions(db, actor, meta)).toBe(2);
    const remaining = await db.select().from(sessions).where(eq(sessions.userId, admin.userId));
    expect(remaining.map((row) => row.id)).toEqual([actor.sessionId]);
  });
});
