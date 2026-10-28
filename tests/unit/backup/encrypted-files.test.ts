import { generateIdentity, identityToRecipient } from "age-encryption";
import { describe, expect, it } from "vitest";
import {
  decryptionFailure,
  identitiesFrom,
  recipientsFileFrom,
  secretFromEnv,
} from "@/modules/backup";
import { ageFormatOf } from "@/modules/backup/encryption";

describe("secretFromEnv", () => {
  it("reads the variable named, then removes it so no child process inherits it", () => {
    const env: Record<string, string> = { VAULT_TEST_SECRET: "a passphrase in the env" };
    expect(secretFromEnv("VAULT_TEST_SECRET", env)).toBe("a passphrase in the env");
    expect(env).not.toHaveProperty("VAULT_TEST_SECRET");
  });

  it("never echoes what is not a variable's name: it may be the passphrase itself", () => {
    const typedByMistake = "my backup passphrase 2026";
    const env: Record<string, string> = {};
    expect(() => secretFromEnv(typedByMistake, env)).toThrow(/name of an environment variable/);
    try {
      secretFromEnv(typedByMistake, env);
    } catch (error) {
      expect((error as Error).message).not.toContain(typedByMistake);
    }
    expect(secretFromEnv("_Vault_2", { _Vault_2: "x" })).toBe("x");
  });

  it("refuses a variable that is unset or empty, naming the variable only", () => {
    expect(() => secretFromEnv("VAULT_TEST_SECRET", {})).toThrow(/VAULT_TEST_SECRET is not set/);
    expect(() => secretFromEnv("VAULT_TEST_SECRET", { VAULT_TEST_SECRET: "" })).toThrow(/not set/);
  });
});

describe("identitiesFrom", () => {
  it("reads age-keygen's file: identities, with comments and blank lines skipped", async () => {
    const [first, second] = [await generateIdentity(), await generateIdentity()];
    const file = [
      "# created: 2026-10-28T00:00:00Z",
      `# public key: ${await identityToRecipient(first)}`,
      first,
      "",
      `  ${second}  `,
      "",
    ].join("\r\n");
    expect(identitiesFrom(file)).toEqual([first, second]);
  });

  it("refuses a file without identities, or with keys of another kind", async () => {
    expect(() => identitiesFrom("# nothing here\n\n")).toThrow(/no age identity/);
    const valid = await generateIdentity();
    for (const other of [
      await identityToRecipient(await generateIdentity()), // a public key, not an identity
      "AGE-PLUGIN-YUBIKEY-1QQQQQQQQQQQQQQQQQQQQQQ",
      "-----BEGIN OPENSSH PRIVATE KEY-----",
      (await generateIdentity()).toLowerCase(),
    ]) {
      expect(() => identitiesFrom(`${valid}\n${other}\n`), other).toThrow(/X25519 identity/);
    }
  });
});

describe("recipientsFileFrom", () => {
  it("reads one recipient per line, skipping comments and blank lines", () => {
    expect(recipientsFileFrom("# alice\nage1aaa\n\n  age1bbb \n# bob\n")).toEqual([
      "age1aaa",
      "age1bbb",
    ]);
  });
});

describe("ageFormatOf", () => {
  it("tells binary from armored age files, and other files from both", () => {
    expect(ageFormatOf(Buffer.from("age-encryption.org/v1\n-> X25519 abc\n"))).toBe("binary");
    expect(ageFormatOf(Buffer.from("-----BEGIN AGE ENCRYPTED FILE-----\nYWdl"))).toBe("armored");
    expect(ageFormatOf(Buffer.from([0x50, 0x4b, 0x03, 0x04]))).toBeNull();
  });
});

describe("decryptionFailure", () => {
  const dir = "/var/tmp/vault-restore-abc";

  it("blames the backup for what age reports: the secret, or damage", () => {
    expect(decryptionFailure(new Error("no identity matched"), dir, "header")).toMatchObject({
      code: "DECRYPTION_FAILED",
      message: expect.stringMatching(/wrong passphrase or identity/),
    });
    for (const error of [
      new Error("invalid tag"),
      Object.assign(new Error("Premature close"), { code: "ERR_STREAM_PREMATURE_CLOSE" }),
    ]) {
      expect(decryptionFailure(error, dir, "body")).toMatchObject({
        code: "DECRYPTION_FAILED",
        message: expect.stringMatching(/damaged or incomplete/),
      });
    }
  });

  it("blames the disk for a system error, and says where and what to do", () => {
    for (const code of ["ENOSPC", "EACCES", "EIO", "EDQUOT"]) {
      const error = Object.assign(new Error(`${code}: write failed`), { code });
      const failure = decryptionFailure(error, dir, "body");
      expect(failure).not.toHaveProperty("code", "DECRYPTION_FAILED");
      expect(failure.message).toContain(`/var/tmp (${code})`);
      expect(failure.message).toContain("set TMPDIR");
      expect(failure.cause).toBe(error);
    }
  });
});
