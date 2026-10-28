import { createCipheriv, createHash, randomBytes, scrypt } from "node:crypto";
import { Encrypter, type ReadableStreamWithSize, type Recipient, Stanza } from "age-encryption";
import {
  PASSPHRASE_MAX,
  PASSPHRASE_MIN,
  passphraseProblem,
  RECIPIENTS_MAX,
  recipientsProblem,
} from "@/lib/backup-encryption";
import { AppError } from "@/lib/errors";

/**
 * Built-in `age` encryption of exports (P1A-ENC, ADR-022). The vault never keeps a passphrase
 * or key: an archive is encrypted while it is streamed out of the vault (a download), with the
 * secret only in that request's memory. Passphrases go through age's scrypt (work factor 2^18,
 * age's own); recipients are X25519 public keys, whose private keys the owner keeps elsewhere.
 */

export { PASSPHRASE_MAX, PASSPHRASE_MIN, RECIPIENTS_MAX };

export type EncryptionOptions =
  { kind: "passphrase"; passphrase: string } | { kind: "recipients"; recipients: string[] };

/**
 * What the owner chose, validated by the rules the export panel also applies
 * (`src/lib/backup-encryption.ts`): a printable-ASCII passphrase, or 1–10 X25519 recipients,
 * never both (the age spec forbids it). Errors never echo the secret.
 */
export function encryptionOptions(input: {
  passphrase?: string | null;
  recipients?: string[] | null;
}): EncryptionOptions {
  const passphrase = input.passphrase ?? "";
  const recipients = [
    ...new Set((input.recipients ?? []).map((value) => value.trim()).filter(Boolean)),
  ];
  if (passphrase && recipients.length > 0) {
    throw new AppError("VALIDATION_FAILED", "Use either a passphrase or recipients, not both");
  }
  if (recipients.length > 0) {
    const problem = recipientsProblem(recipients);
    if (problem === "count") {
      throw new AppError("VALIDATION_FAILED", `At most ${RECIPIENTS_MAX} recipients`);
    }
    if (problem) {
      throw new AppError("VALIDATION_FAILED", "Recipients are age X25519 public keys (age1…)");
    }
    return { kind: "recipients", recipients };
  }
  const problem = passphraseProblem(passphrase);
  if (problem === "characters") {
    throw new AppError(
      "VALIDATION_FAILED",
      "Passphrases use printable ASCII only, so any age tool can take them",
    );
  }
  if (problem) {
    throw new AppError(
      "VALIDATION_FAILED",
      `Passphrases are ${PASSPHRASE_MIN} to ${PASSPHRASE_MAX} characters`,
    );
  }
  return { kind: "passphrase", passphrase };
}

// ---------- the passphrase recipient ----------

/** age's scrypt parameters (age-encryption.org/v1, "scrypt" recipient). */
const SCRYPT_LOG_N = 18;
const SCRYPT_LABEL = "age-encryption.org/v1/scrypt";
/** 128 · r · N bytes for r = 8, N = 2^18, plus headroom; Node's default cap is 32 MiB. */
const SCRYPT_MAXMEM = 300 * 1024 * 1024;
/**
 * Derivations queued or running; past that, the server is busy (429). Four is about four
 * seconds of waiting, more than a personal vault's owner ever asks for at once.
 */
export const SCRYPT_QUEUE_MAX = 4;

let derivations = Promise.resolve();
let waiting = 0;

/**
 * One scrypt derivation at a time per process, each on Node's thread pool. It takes about a
 * second and 256 MiB: run synchronously (as typage does) it would stall every other request,
 * and run side by side it would multiply the memory.
 */
async function deriveOneAtATime(passphrase: string, salt: Buffer): Promise<Buffer> {
  if (waiting >= SCRYPT_QUEUE_MAX) {
    throw new AppError("RATE_LIMITED", "Busy encrypting other exports; try again in a moment");
  }
  waiting += 1;
  const turn = derivations.then(
    () =>
      new Promise<Buffer>((resolve, reject) =>
        scrypt(
          passphrase,
          salt,
          32,
          { N: 2 ** SCRYPT_LOG_N, r: 8, p: 1, maxmem: SCRYPT_MAXMEM },
          (error, key) => (error ? reject(error) : resolve(key)),
        ),
      ),
  );
  derivations = turn.then(
    () => undefined,
    () => undefined,
  );
  try {
    return await turn;
  } finally {
    waiting -= 1;
  }
}

/**
 * age's passphrase recipient, written to the spec: the file key sealed with ChaCha20-Poly1305
 * (zero nonce) under scrypt(passphrase, label ‖ 16-byte salt). typage's own recipient computes
 * the same stanza synchronously on the event loop; this one awaits `deriveOneAtATime`.
 */
class PassphraseRecipient implements Recipient {
  constructor(private readonly passphrase: string) {}

  async wrapFileKey(fileKey: Uint8Array): Promise<Stanza[]> {
    const salt = randomBytes(16);
    const key = await deriveOneAtATime(
      this.passphrase,
      Buffer.concat([Buffer.from(SCRYPT_LABEL), salt]),
    );
    const cipher = createCipheriv("chacha20-poly1305", key, Buffer.alloc(12), {
      authTagLength: 16,
    });
    const body = Buffer.concat([cipher.update(fileKey), cipher.final(), cipher.getAuthTag()]);
    const encodedSalt = salt.toString("base64").replace(/=+$/, "");
    return [new Stanza(["scrypt", encodedSalt, String(SCRYPT_LOG_N)], body)];
  }
}

// ---------- streaming ----------

/**
 * Encrypts `plaintext` while counting and hashing it. A stream longer than `expected.byteSize`
 * fails as soon as it is, and one whose SHA-256 is not `expected.sha256` fails at its end: in
 * both cases before age writes its final chunk, so a damaged archive never becomes a valid
 * encrypted file (an age file without its final chunk does not decrypt).
 */
export function encryptVerified(
  plaintext: ReadableStream<Uint8Array>,
  options: EncryptionOptions,
  expected: { sha256: string; byteSize: number },
): Promise<ReadableStreamWithSize> {
  const hash = createHash("sha256");
  let seen = 0;
  const mismatch = () =>
    new AppError("CHECKSUM_MISMATCH", "The stored archive does not match its SHA-256");
  const verified = plaintext.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        seen += chunk.byteLength;
        if (seen > expected.byteSize) throw mismatch();
        hash.update(chunk);
        controller.enqueue(chunk);
      },
      flush() {
        if (seen !== expected.byteSize || hash.digest("hex") !== expected.sha256) {
          throw mismatch();
        }
      },
    }),
  );
  const encrypter = new Encrypter();
  if (options.kind === "passphrase") {
    encrypter.addRecipient(new PassphraseRecipient(options.passphrase));
  } else {
    for (const recipient of options.recipients) encrypter.addRecipient(recipient);
  }
  return encrypter.encrypt(verified);
}

const AGE_MAGIC = "age-encryption.org/v1\n";
const AGE_ARMOR = "-----BEGIN AGE ENCRYPTED FILE-----";

/** Whether `head` (a file's first bytes) starts an age file, binary or ASCII-armored. */
export function isAgeEncrypted(head: Uint8Array): boolean {
  const text = Buffer.from(head.subarray(0, AGE_ARMOR.length)).toString("latin1");
  return text.startsWith(AGE_MAGIC) || text.startsWith(AGE_ARMOR);
}
