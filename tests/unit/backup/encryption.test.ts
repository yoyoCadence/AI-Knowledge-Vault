import { createHash, randomBytes } from "node:crypto";
import { Decrypter, generateIdentity, identityToRecipient } from "age-encryption";
import { describe, expect, it } from "vitest";
import { passphraseProblem, recipientsFrom, recipientsProblem } from "@/lib/backup-encryption";
import { encryptionOptions, encryptVerified, isAgeEncrypted } from "@/modules/backup";
import { SCRYPT_QUEUE_MAX } from "@/modules/backup/encryption";

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

/** An X25519 recipient's shape with arbitrary data: enough for the rules, not a real key. */
const FAKE_RECIPIENT = `age1${"q".repeat(58)}`;

describe("encryptionOptions", () => {
  it("takes a printable-ASCII passphrase of 12 to 1,024 characters", () => {
    expect(encryptionOptions({ passphrase: PASSPHRASE })).toEqual({
      kind: "passphrase",
      passphrase: PASSPHRASE,
    });
    expect(encryptionOptions({ passphrase: "x".repeat(1_024) }).kind).toBe("passphrase");
    for (const passphrase of ["", "elevenchars", "x".repeat(1_025)]) {
      expect(() => encryptionOptions({ passphrase })).toThrow(/12 to 1024/);
    }
    // Spaces are part of a passphrase: not trimmed.
    expect(encryptionOptions({ passphrase: ` ${PASSPHRASE} ` })).toMatchObject({
      passphrase: ` ${PASSPHRASE} `,
    });
  });

  it("refuses passphrases another console could type differently", () => {
    for (const passphrase of [
      "十二個字的中文密碼是可以的嗎",
      `${PASSPHRASE}\u00e9`, // é: one code point here, two in another normalization
      `${PASSPHRASE}\t`,
      `${PASSPHRASE}\n`,
    ]) {
      expect(() => encryptionOptions({ passphrase })).toThrow(/printable ASCII/);
    }
  });

  it("takes 1–10 X25519 recipients, deduplicated, and never with a passphrase", async () => {
    const recipient = await identityToRecipient(await generateIdentity());
    expect(encryptionOptions({ recipients: [` ${recipient} `, recipient, ""] })).toEqual({
      kind: "recipients",
      recipients: [recipient],
    });
    const many = await Promise.all(
      Array.from({ length: 11 }, async () => identityToRecipient(await generateIdentity())),
    );
    expect(encryptionOptions({ recipients: many.slice(0, 10) }).kind).toBe("recipients");
    expect(() => encryptionOptions({ recipients: many })).toThrow(/At most 10/);
    expect(() => encryptionOptions({ passphrase: PASSPHRASE, recipients: [recipient] })).toThrow(
      /not both/,
    );
  });

  it("refuses anything but an X25519 public key as a recipient", async () => {
    const identity = await generateIdentity();
    for (const recipient of [
      "age1notakey",
      "ssh-ed25519 AAAA",
      identity, // a private key pasted by mistake
      `age1pq1${"q".repeat(80)}`, // post-quantum: older age versions cannot decrypt it
      (await identityToRecipient(identity)).toUpperCase(),
      `${FAKE_RECIPIENT}q`,
      `${FAKE_RECIPIENT.slice(0, -1)}b`, // "b" is not a bech32 character
    ]) {
      expect(() => encryptionOptions({ recipients: [recipient] }), recipient).toThrow(/age1/);
    }
  });

  it("never puts the secret in an error", () => {
    expect.assertions(2);
    for (const secret of ["eleven-char", "密碼是一段不能出現在錯誤裡的文字"]) {
      try {
        encryptionOptions({ passphrase: secret });
      } catch (error) {
        expect(String((error as Error).message)).not.toContain(secret);
      }
    }
  });
});

describe("the rules the export panel shares", () => {
  it("reads recipients one per line, without repeats", () => {
    expect(recipientsFrom(`  ${FAKE_RECIPIENT}\r\n\n${FAKE_RECIPIENT} \t`)).toEqual([
      FAKE_RECIPIENT,
    ]);
    expect(recipientsFrom(" \n ")).toEqual([]);
  });

  it("names the problem, as the server would", () => {
    expect(passphraseProblem(PASSPHRASE)).toBeNull();
    expect(passphraseProblem("short")).toBe("length");
    expect(passphraseProblem("中文密碼")).toBe("characters");
    expect(recipientsProblem([FAKE_RECIPIENT])).toBeNull();
    expect(recipientsProblem([])).toBe("none");
    expect(recipientsProblem(Array.from({ length: 11 }, () => FAKE_RECIPIENT))).toBe("count");
    expect(recipientsProblem([FAKE_RECIPIENT, "age1x"])).toBe("format");
  });
});

/** Expected size and SHA-256 of `bytes`, as an export run records them. */
const recordOf = (bytes: Uint8Array) => ({ sha256: sha256(bytes), byteSize: bytes.length });

describe("encryptVerified", { timeout: 30_000 }, () => {
  const archive = randomBytes(200_000); // several age chunks (64 KiB each)

  it("encrypts with a passphrase or to recipients, decryptable by age", async () => {
    const byPassphrase = await encryptVerified(
      streamOf(archive),
      { kind: "passphrase", passphrase: PASSPHRASE },
      recordOf(archive),
    );
    const { bytes, error } = await drain(byPassphrase);
    expect(error).toBeNull();
    expect(byPassphrase.size(archive.length)).toBe(bytes.length);
    expect(isAgeEncrypted(bytes)).toBe(true);
    // The stanza is age's: scrypt, a 16-byte salt, work factor 18.
    expect(bytes.toString("latin1")).toMatch(/^age-encryption\.org\/v1\n-> scrypt [\w+/]{22} 18\n/);
    const withPassphrase = new Decrypter();
    withPassphrase.addPassphrase(PASSPHRASE);
    expect(sha256(await withPassphrase.decrypt(bytes))).toBe(sha256(archive));

    const identity = await generateIdentity();
    const toRecipient = await encryptVerified(
      streamOf(archive),
      { kind: "recipients", recipients: [await identityToRecipient(identity)] },
      recordOf(archive),
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

  it("derives the key off the event loop, so other requests go on meanwhile", async () => {
    let last = performance.now();
    let longestStall = 0;
    const tick = () => {
      const now = performance.now();
      longestStall = Math.max(longestStall, now - last);
      last = now;
    };
    const timer = setInterval(tick, 5);
    try {
      const stream = await encryptVerified(
        streamOf(archive),
        { kind: "passphrase", passphrase: PASSPHRASE },
        recordOf(archive),
      );
      await drain(stream);
    } finally {
      clearInterval(timer);
    }
    tick(); // the last stretch too: blocked work then microtasks may never let the timer run
    // scrypt at 2^18 takes about a second; on the event loop it would stall it that long.
    expect(longestStall).toBeLessThan(250);
  });

  it("is busy (429) past a few derivations at once, without leaving any behind", async () => {
    const started = Array.from({ length: SCRYPT_QUEUE_MAX + 1 }, () =>
      encryptVerified(
        streamOf(archive),
        { kind: "passphrase", passphrase: PASSPHRASE },
        recordOf(archive),
      ),
    );
    const settled = await Promise.allSettled(started);
    expect(settled.filter((result) => result.status === "fulfilled")).toHaveLength(
      SCRYPT_QUEUE_MAX,
    );
    expect(settled.at(-1)).toMatchObject({
      status: "rejected",
      reason: { code: "RATE_LIMITED" },
    });
    for (const result of settled) {
      if (result.status === "fulfilled") await result.value.cancel();
    }
    // The queue is empty again: the next one goes through.
    await expect(
      encryptVerified(
        streamOf(archive),
        { kind: "passphrase", passphrase: PASSPHRASE },
        recordOf(archive),
      ),
    ).resolves.toBeDefined();
  });

  it("fails before the final chunk when the archive does not match its SHA-256", async () => {
    const damaged = Buffer.from(archive);
    damaged[150_000] = damaged[150_000]! ^ 0xff;
    const identity = await generateIdentity();
    const stream = await encryptVerified(
      streamOf(damaged),
      { kind: "recipients", recipients: [await identityToRecipient(identity)] },
      recordOf(archive),
    );
    const { bytes, error } = await drain(stream);
    expect(error).toMatchObject({ code: "CHECKSUM_MISMATCH" });
    // Whatever was sent before the failure is not a file that decrypts.
    const decrypter = new Decrypter();
    decrypter.addIdentity(identity);
    await expect(decrypter.decrypt(bytes)).rejects.toThrow();
  });

  it("stops reading as soon as the archive runs past its recorded size", async () => {
    // The recorded archive, then much more: the size check, not the hash at the end, stops it.
    let read = 0;
    let offset = 0;
    const tooLong = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (offset >= 50 * archive.length) return controller.close();
        const chunk = Buffer.from(archive.subarray(offset % archive.length).subarray(0, 16_384));
        offset += chunk.length;
        read += chunk.length;
        controller.enqueue(chunk);
      },
    });
    const identity = await generateIdentity();
    const stream = await encryptVerified(
      tooLong,
      { kind: "recipients", recipients: [await identityToRecipient(identity)] },
      recordOf(archive),
    );
    const { bytes, error } = await drain(stream);
    expect(error).toMatchObject({ code: "CHECKSUM_MISMATCH" });
    expect(read).toBeLessThan(2 * archive.length);
    const decrypter = new Decrypter();
    decrypter.addIdentity(identity);
    await expect(decrypter.decrypt(bytes)).rejects.toThrow();
  });

  it("fails when the archive is shorter than recorded, even with the right bytes so far", async () => {
    const stream = await encryptVerified(
      streamOf(archive.subarray(0, 100_000)),
      { kind: "recipients", recipients: [await identityToRecipient(await generateIdentity())] },
      recordOf(archive),
    );
    expect((await drain(stream)).error).toMatchObject({ code: "CHECKSUM_MISMATCH" });
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
