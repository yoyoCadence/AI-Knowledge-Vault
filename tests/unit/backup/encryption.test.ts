import { createHash, randomBytes } from "node:crypto";
import { Decrypter, generateIdentity, identityToRecipient } from "age-encryption";
import { describe, expect, it } from "vitest";
import { encryptionOptions, encryptVerified, isAgeEncrypted } from "@/modules/backup";

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** A stream of `bytes` in chunks, as storage hands an archive over. */
function streamOf(bytes: Uint8Array, chunk = 16_384): ReadableStream<Uint8Array> {
  let offset = 0;
  return new ReadableStream({
    pull(controller) {
      if (offset >= bytes.length) return controller.close();
      controller.enqueue(bytes.subarray(offset, offset + chunk));
      offset += chunk;
    },
  });
}

/** Everything a stream yields, and the error it ended with, if any. */
async function drain(stream: ReadableStream<Uint8Array>) {
  const parts: Uint8Array[] = [];
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return { bytes: Buffer.concat(parts), error: null };
      parts.push(value);
    }
  } catch (error) {
    return { bytes: Buffer.concat(parts), error };
  }
}

const PASSPHRASE = "correct horse battery staple";

describe("encryptionOptions", () => {
  it("takes a passphrase of 12 to 1,024 characters, counted as characters", () => {
    expect(encryptionOptions({ passphrase: PASSPHRASE })).toEqual({
      kind: "passphrase",
      passphrase: PASSPHRASE,
    });
    expect(encryptionOptions({ passphrase: "十二個字的中文密碼是可以的" }).kind).toBe("passphrase");
    for (const passphrase of ["", "elevenchars", "x".repeat(1_025)]) {
      expect(() => encryptionOptions({ passphrase })).toThrow(/12 to 1024/);
    }
    // Spaces are part of a passphrase: not trimmed.
    expect(encryptionOptions({ passphrase: ` ${PASSPHRASE} ` })).toMatchObject({
      passphrase: ` ${PASSPHRASE} `,
    });
  });

  it("takes 1–10 age recipients, deduplicated, and never with a passphrase", async () => {
    const recipient = await identityToRecipient(await generateIdentity());
    expect(encryptionOptions({ recipients: [` ${recipient} `, recipient, ""] })).toEqual({
      kind: "recipients",
      recipients: [recipient],
    });
    expect(() => encryptionOptions({ recipients: ["age1notakey"] })).toThrow(/age1/);
    expect(() => encryptionOptions({ recipients: ["ssh-ed25519 AAAA"] })).toThrow(/age1/);
    const many = await Promise.all(
      Array.from({ length: 11 }, async () => identityToRecipient(await generateIdentity())),
    );
    expect(() => encryptionOptions({ recipients: many })).toThrow(/At most 10/);
    expect(() => encryptionOptions({ passphrase: PASSPHRASE, recipients: [recipient] })).toThrow(
      /not both/,
    );
  });

  it("never puts the secret in an error", () => {
    const secret = "short-secret";
    try {
      encryptionOptions({ passphrase: secret.slice(0, 11) });
    } catch (error) {
      expect(String((error as Error).message)).not.toContain(secret.slice(0, 11));
    }
  });
});

describe("encryptVerified", () => {
  const archive = randomBytes(200_000); // several age chunks (64 KiB each)

  it("encrypts with a passphrase or to recipients, decryptable by age", async () => {
    const byPassphrase = await encryptVerified(
      streamOf(archive),
      { kind: "passphrase", passphrase: PASSPHRASE },
      sha256(archive),
    );
    const { bytes, error } = await drain(byPassphrase);
    expect(error).toBeNull();
    expect(byPassphrase.size(archive.length)).toBe(bytes.length);
    expect(isAgeEncrypted(bytes)).toBe(true);
    const withPassphrase = new Decrypter();
    withPassphrase.addPassphrase(PASSPHRASE);
    expect(sha256(await withPassphrase.decrypt(bytes))).toBe(sha256(archive));

    const identity = await generateIdentity();
    const toRecipient = await encryptVerified(
      streamOf(archive),
      { kind: "recipients", recipients: [await identityToRecipient(identity)] },
      sha256(archive),
    );
    const sealed = await drain(toRecipient);
    const withIdentity = new Decrypter();
    withIdentity.addIdentity(identity);
    expect(sha256(await withIdentity.decrypt(sealed.bytes))).toBe(sha256(archive));
    // The wrong passphrase decrypts nothing.
    const wrong = new Decrypter();
    wrong.addPassphrase("not the passphrase at all");
    await expect(wrong.decrypt(bytes)).rejects.toThrow();
  });

  it("fails before the final chunk when the archive does not match its SHA-256", async () => {
    const damaged = Buffer.from(archive);
    damaged[150_000] = damaged[150_000]! ^ 0xff;
    const stream = await encryptVerified(
      streamOf(damaged),
      { kind: "passphrase", passphrase: PASSPHRASE },
      sha256(archive),
    );
    const { bytes, error } = await drain(stream);
    expect(error).toMatchObject({ code: "CHECKSUM_MISMATCH" });
    // Whatever was sent before the failure is not a file that decrypts.
    const decrypter = new Decrypter();
    decrypter.addPassphrase(PASSPHRASE);
    await expect(decrypter.decrypt(bytes)).rejects.toThrow();
  });
});

describe("isAgeEncrypted", () => {
  it("recognises binary and armored age files, and nothing else", () => {
    expect(isAgeEncrypted(Buffer.from("age-encryption.org/v1\n-> scrypt abc 18\n"))).toBe(true);
    expect(isAgeEncrypted(Buffer.from("-----BEGIN AGE ENCRYPTED FILE-----\nYWdl"))).toBe(true);
    expect(isAgeEncrypted(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0]))).toBe(false);
    expect(isAgeEncrypted(Buffer.from("age-encryption"))).toBe(false);
    expect(isAgeEncrypted(new Uint8Array())).toBe(false);
  });
});
