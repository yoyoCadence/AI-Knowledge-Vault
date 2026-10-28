import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Decrypter, generateIdentity, identityToRecipient } from "age-encryption";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { POST as encryptedRoute } from "@/app/api/exports/[id]/encrypted/route";
import { GET as manifestRoute } from "@/app/api/exports/[id]/manifest/route";
import { getEnv } from "@/infrastructure/config/env";
import { closeDb } from "@/infrastructure/database/client";
import {
  artifacts,
  auditLogs,
  exportRuns,
  workspaceMembers,
} from "@/infrastructure/database/schema";
import { getStorage } from "@/infrastructure/storage";
import { newId } from "@/lib/ids";
import { requestExport, restoreArchive, restoreLimitsFromEnv } from "@/modules/backup";
import { htmlDocument } from "@tests/fixtures/builders";
import { createTestAdmin, signInOk } from "../helpers/auth";
import { closeTestDb, testDb } from "../helpers/db";
import { drainJobs, newBatch, uploadFile } from "../helpers/imports";

const db = testDb();
const env = getEnv();
const meta = { ipAddress: null, userAgent: "vitest" };
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const PASSPHRASE = "a long passphrase only this test knows 7f3a";
let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "vault-encrypted-export-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
  await closeDb();
  await closeTestDb();
});

const params = <T>(value: T) => ({ params: Promise.resolve(value) });

async function loggedIn() {
  const admin = await createTestAdmin();
  const { cookie } = await signInOk(admin.email, admin.password);
  const actor = {
    userId: admin.userId,
    workspaceId: admin.workspaceId,
    role: "owner" as const,
    sessionId: newId(),
    email: admin.email,
    name: "Owner",
  };
  return { ...admin, cookie, actor };
}
type Owner = Awaited<ReturnType<typeof loggedIn>>;

/** A workspace with one work and a completed export of it. */
async function exported() {
  const owner = await loggedIn();
  await uploadFile(owner.actor, (await newBatch(owner.actor)).id, {
    filename: "sealed.html",
    bytes: htmlDocument({ title: "加密匯出", body: "<p>要加密的內容。</p>" }),
  });
  await drainJobs();
  const requested = await requestExport(db, owner.actor, meta);
  await drainJobs();
  const [run] = await db.select().from(exportRuns).where(eq(exportRuns.id, requested.id));
  expect(run!.status).toBe("completed");
  return { owner, run: run! };
}

function encrypted(
  owner: Owner,
  exportId: string,
  body: string,
  type = "application/x-www-form-urlencoded",
  headers: Record<string, string> = {},
) {
  return encryptedRoute(
    new Request(`${env.APP_ORIGIN}/api/exports/${exportId}/encrypted`, {
      method: "POST",
      headers: { cookie: owner.cookie, origin: env.APP_ORIGIN, "content-type": type, ...headers },
      body,
    }),
    params({ id: exportId }),
  );
}

const form = (fields: Record<string, string>) => new URLSearchParams(fields).toString();
const bytesOf = async (response: Response) => new Uint8Array(await response.arrayBuffer());

/** The reference age CLI, where it is installed; CI installs it (interoperability, ADR-022). */
function ageCli(): string | null {
  let age: string | null = null;
  try {
    age = execFileSync("sh", ["-c", "command -v age"]).toString().trim() || null;
  } catch {
    age = null;
  }
  if (!age && process.env.CI) {
    throw new Error("the age CLI must be installed in CI (.github/workflows/ci.yml)");
  }
  if (!age) console.warn("age CLI not installed: interoperability not checked");
  return age;
}

/**
 * Types the passphrase at `age -d`'s prompt, as a person would: age reads it only from a
 * terminal, so this runs age on a pseudo-terminal. The passphrase goes through the
 * environment, not the command line.
 */
const TYPE_AT_PROMPT = String.raw`
import os, pty, sys
age, output, encrypted = sys.argv[1:4]
pid, fd = pty.fork()
if pid == 0:
    os.execv(age, [age, "-d", "-o", output, encrypted])
def read():
    try:
        return os.read(fd, 1024)
    except OSError:
        return b""
seen = b""
while b"passphrase" not in seen.lower():
    chunk = read()
    if not chunk:
        break
    seen += chunk
os.write(fd, os.environ["AGE_TEST_PASSPHRASE"].encode() + b"\n")
while read():
    pass
_, status = os.waitpid(pid, 0)
sys.exit(os.waitstatus_to_exitcode(status))
`;

describe("POST /api/exports/:id/encrypted (ADR-022)", () => {
  let owner: Owner;
  let run: Awaited<ReturnType<typeof exported>>["run"];
  beforeAll(async () => {
    ({ owner, run } = await exported());
  });

  it("streams the archive encrypted with a passphrase, and stores nothing secret", async () => {
    const response = await encrypted(owner, run.id, form({ passphrase: PASSPHRASE }));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).toContain(`${run.filename}.age`);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-plaintext-sha256")).toBe(run.sha256);
    const body = await bytesOf(response);
    expect(Number(response.headers.get("content-length"))).toBe(body.length);
    const decrypter = new Decrypter();
    decrypter.addPassphrase(PASSPHRASE);
    expect(sha256(await decrypter.decrypt(body))).toBe(run.sha256);

    // Audited without the secret; the secret is nowhere in the database.
    const [audit] = await db
      .select({ metadata: auditLogs.metadata })
      .from(auditLogs)
      .where(and(eq(auditLogs.action, "backup.export.downloaded"), eq(auditLogs.targetId, run.id)));
    expect(audit!.metadata).toEqual({
      sha256: run.sha256,
      byteSize: run.byteSize,
      encryption: "passphrase",
    });
    const leaks = await db.execute<{ n: number }>(sql`
      select (select count(*) from audit_logs where metadata::text like ${`%${PASSPHRASE}%`})
           + (select count(*) from processing_jobs where payload::text like ${`%${PASSPHRASE}%`})
           + (select count(*) from export_runs where options::text like ${`%${PASSPHRASE}%`})
        as n`);
    expect(Number(leaks.rows[0]!.n)).toBe(0);
  });

  it("is decrypted by the age CLI with the passphrase typed at its prompt", async () => {
    const response = await encrypted(owner, run.id, form({ passphrase: PASSPHRASE }));
    expect(response.status).toBe(200);
    const body = await bytesOf(response);
    const age = ageCli();
    if (!age) return;
    const input = path.join(dir, "by-passphrase.zip.age");
    const output = path.join(dir, "by-passphrase.zip");
    const script = path.join(dir, "type-at-prompt.py");
    await writeFile(input, body);
    await writeFile(script, TYPE_AT_PROMPT);
    execFileSync("python3", ["-I", script, age, output, input], {
      env: { ...process.env, AGE_TEST_PASSPHRASE: PASSPHRASE },
      timeout: 60_000,
    });
    expect(execFileSync("sha256sum", [output]).toString().split(" ")[0]).toBe(run.sha256);
  });

  it("encrypts to age recipients, from JSON too, and the age CLI decrypts it", async () => {
    const identity = await generateIdentity();
    const response = await encrypted(
      owner,
      run.id,
      JSON.stringify({ recipients: [await identityToRecipient(identity)] }),
      "application/json",
    );
    expect(response.status).toBe(200);
    const body = await bytesOf(response);
    const decrypter = new Decrypter();
    decrypter.addIdentity(identity);
    expect(sha256(await decrypter.decrypt(body))).toBe(run.sha256);

    const age = ageCli();
    if (!age) return;
    const input = path.join(dir, "export.zip.age");
    const key = path.join(dir, "key.txt");
    const output = path.join(dir, "export.zip");
    await writeFile(input, body);
    await writeFile(key, `${identity}\n`, { mode: 0o600 });
    execFileSync(age, ["-d", "-i", key, "-o", output, input]);
    expect(execFileSync("sha256sum", [output]).toString().split(" ")[0]).toBe(run.sha256);
  });

  it("refuses what is not a usable choice, and anyone but the workspace's exporters", async () => {
    const identity = await generateIdentity();
    const recipient = await identityToRecipient(identity);
    for (const [body, type] of [
      [form({ passphrase: "too short" }), undefined],
      [form({ passphrase: "十二個字的中文密碼是不行的" }), undefined],
      [form({ passphrase: PASSPHRASE, recipients: recipient }), undefined],
      [form({ recipients: "not-a-key" }), undefined],
      [form({ recipients: identity }), undefined], // a private key pasted by mistake
      [form({ recipients: `age1pq1${"q".repeat(80)}` }), undefined],
      [form({}), undefined],
      [JSON.stringify({ passphrase: PASSPHRASE, extra: 1 }), "application/json"],
      ["{not json", "application/json"],
    ] as const) {
      const response = await encrypted(owner, run.id, body, type);
      expect(response.status, body).toBe(400);
      const text = await response.text();
      for (const secret of ["too short", "中文密碼", identity]) expect(text).not.toContain(secret);
    }
    // Exactly a form or JSON: no lists, look-alikes or multipart.
    for (const type of [
      "text/plain",
      "multipart/form-data; boundary=x",
      "application/x-www-form-urlencoded, multipart/form-data; boundary=x",
      "application/x-www-form-urlencodedx",
    ]) {
      expect((await encrypted(owner, run.id, PASSPHRASE, type)).status, type).toBe(415);
    }
    expect(
      (await encrypted(owner, run.id, form({ passphrase: PASSPHRASE }), "Application/JSON")).status,
    ).toBe(400); // JSON, case-insensitively: then not JSON
    // A body far past any choice: refused, even one that never ends.
    expect((await encrypted(owner, run.id, form({ passphrase: "x".repeat(20_000) }))).status).toBe(
      413,
    );
    let sent = 0;
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        sent += 1_024;
        controller.enqueue(new Uint8Array(1_024).fill(0x61));
      },
    });
    const cutOff = await encryptedRoute(
      new Request(`${env.APP_ORIGIN}/api/exports/${run.id}/encrypted`, {
        method: "POST",
        headers: {
          cookie: owner.cookie,
          origin: env.APP_ORIGIN,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: endless,
        duplex: "half",
      } as RequestInit),
      params({ id: run.id }),
    );
    expect(cutOff.status).toBe(413);
    expect(sent).toBeLessThan(64 * 1_024);
    expect(
      (
        await encrypted(owner, run.id, form({ passphrase: PASSPHRASE }), undefined, {
          origin: "https://evil.example",
        })
      ).status,
    ).toBe(403);
    expect((await encrypted(owner, newId(), form({ passphrase: PASSPHRASE }))).status).toBe(404);
    expect((await encrypted(owner, "nope", form({ passphrase: PASSPHRASE }))).status).toBe(404);
    const stranger = await loggedIn();
    expect((await encrypted(stranger, run.id, form({ passphrase: PASSPHRASE }))).status).toBe(404);
    const viewer = await loggedIn();
    await db
      .update(workspaceMembers)
      .set({ workspaceId: owner.workspaceId, role: "viewer" })
      .where(eq(workspaceMembers.userId, viewer.userId));
    expect((await encrypted(viewer, run.id, form({ passphrase: PASSPHRASE }))).status).toBe(403);
    // Not ready (or expired): a conflict, as for the plain download.
    const pending = await requestExport(db, owner.actor, meta);
    expect((await encrypted(owner, pending.id, form({ passphrase: PASSPHRASE }))).status).toBe(409);
    await drainJobs();
  });

  it("aborts, undecryptable, when the stored archive no longer matches its SHA-256", async () => {
    const { owner: other, run: damagedRun } = await exported();
    const { body } = await getStorage().getObject(damagedRun.storageKey!);
    const stored = Buffer.concat(await body.toArray());
    stored[Math.floor(stored.length / 2)] = stored[Math.floor(stored.length / 2)]! ^ 0xff;
    await getStorage().putObject(damagedRun.storageKey!, stored, {
      contentType: "application/zip",
    });
    const response = await encrypted(other, damagedRun.id, form({ passphrase: PASSPHRASE }));
    expect(response.status).toBe(200); // headers went out before the mismatch was known
    await expect(response.arrayBuffer()).rejects.toThrow();
  });

  it("refuses, before any byte goes out, a stored archive of another size", async () => {
    const { owner: other, run: grownRun } = await exported();
    const { body } = await getStorage().getObject(grownRun.storageKey!);
    const stored = Buffer.concat(await body.toArray());
    await getStorage().putObject(grownRun.storageKey!, Buffer.concat([stored, Buffer.alloc(10)]), {
      contentType: "application/zip",
    });
    const response = await encrypted(other, grownRun.id, form({ passphrase: PASSPHRASE }));
    expect(response.status).toBe(422);
    expect(response.headers.get("content-disposition")).toBeNull();
    expect(await response.json()).toMatchObject({ error: { code: "CHECKSUM_MISMATCH" } });
  });

  it("gives the sidecar: what the archive holds, readable without decrypting", async () => {
    const response = await manifestRoute(
      new Request(`${env.APP_ORIGIN}/api/exports/${run.id}/manifest`, {
        headers: { cookie: owner.cookie },
      }),
      params({ id: run.id }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).toContain(
      `${run.filename}.age.manifest.json`,
    );
    const sidecar = (await response.json()) as Record<string, unknown>;
    expect(sidecar).toMatchObject({
      sidecarVersion: 1,
      encrypted: { format: "age", filename: `${run.filename}.age` },
      archive: { filename: run.filename, sha256: run.sha256, byteSize: run.byteSize },
      manifest: { counts: { artifacts: 1 } },
    });
    // Not the workspace's name: the sidecar sits unencrypted beside the backup. (Its slug is in
    // the file name, as in the plain download's: BACKUP_RECOVERY §4.)
    const { rows } = await db.execute<{ name: string }>(
      sql`select name from workspaces where id = ${owner.workspaceId}`,
    );
    expect(sidecar).not.toHaveProperty("workspace");
    expect(JSON.stringify(sidecar)).not.toContain(rows[0]!.name);
  });
});

describe("restoring an encrypted archive", () => {
  it("is refused before anything is written, with how to decrypt it", async () => {
    const target = await loggedIn();
    const file = path.join(dir, "backup.zip.age");
    await writeFile(file, "age-encryption.org/v1\n-> scrypt c2FsdA 18\nbm90IHJlYWw\n--- x\n");
    await expect(
      restoreArchive(db, getStorage(), {
        archivePath: file,
        workspaceId: target.workspaceId,
        userId: target.userId,
        mode: "skip_existing",
        restoreId: crypto.randomUUID(),
        limits: restoreLimitsFromEnv(env),
      }),
    ).rejects.toMatchObject({
      code: "UNSUPPORTED_EXPORT_FORMAT",
      message: expect.stringContaining("age -d"),
      details: { encrypted: true, nothingWritten: true },
    });
    expect(
      await db.select().from(artifacts).where(eq(artifacts.workspaceId, target.workspaceId)),
    ).toEqual([]);
  });
});
