import { createHash } from "node:crypto";
import { Encrypter, type ReadableStreamWithSize } from "age-encryption";
import { PASSPHRASE_MAX, PASSPHRASE_MIN, RECIPIENTS_MAX } from "@/lib/backup-encryption";
import { AppError } from "@/lib/errors";

/**
 * Built-in `age` encryption of exports (P1A-ENC, ADR-022). The vault never keeps a passphrase
 * or key: an archive is encrypted while it is streamed out of the vault (a download), with the
 * secret only in that request's memory. Passphrases go through age's scrypt (work factor 2^18);
 * recipients are age public keys, whose identities (private keys) the owner keeps elsewhere.
 */

export { PASSPHRASE_MAX, PASSPHRASE_MIN, RECIPIENTS_MAX };

export type EncryptionOptions =
  { kind: "passphrase"; passphrase: string } | { kind: "recipients"; recipients: string[] };

/**
 * What the owner chose, validated: a passphrase, or 1–10 age recipients (age spec: a passphrase
 * cannot be combined with recipients). Errors never echo the secret.
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
    if (recipients.length > RECIPIENTS_MAX) {
      throw new AppError("VALIDATION_FAILED", `At most ${RECIPIENTS_MAX} recipients`);
    }
    for (const recipient of recipients) {
      try {
        new Encrypter().addRecipient(recipient);
      } catch {
        throw new AppError("VALIDATION_FAILED", "Recipients are age public keys (age1…)");
      }
    }
    return { kind: "recipients", recipients };
  }
  const length = [...passphrase].length;
  if (length < PASSPHRASE_MIN || length > PASSPHRASE_MAX) {
    throw new AppError(
      "VALIDATION_FAILED",
      `Passphrases are ${PASSPHRASE_MIN} to ${PASSPHRASE_MAX} characters`,
    );
  }
  return { kind: "passphrase", passphrase };
}

/**
 * Encrypts `plaintext` while hashing it. If its SHA-256 is not `expectedSha256` the stream
 * fails before age writes its final chunk, so a damaged archive never becomes a valid
 * encrypted file: an age file without its final chunk does not decrypt.
 */
export function encryptVerified(
  plaintext: ReadableStream<Uint8Array>,
  options: EncryptionOptions,
  expectedSha256: string,
): Promise<ReadableStreamWithSize> {
  const hash = createHash("sha256");
  const verified = plaintext.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        hash.update(chunk);
        controller.enqueue(chunk);
      },
      flush() {
        if (hash.digest("hex") !== expectedSha256) {
          throw new AppError("CHECKSUM_MISMATCH", "The stored archive does not match its SHA-256");
        }
      },
    }),
  );
  const encrypter = new Encrypter();
  if (options.kind === "passphrase") encrypter.setPassphrase(options.passphrase);
  else for (const recipient of options.recipients) encrypter.addRecipient(recipient);
  return encrypter.encrypt(verified);
}

const AGE_MAGIC = "age-encryption.org/v1\n";
const AGE_ARMOR = "-----BEGIN AGE ENCRYPTED FILE-----";

/** Whether `head` (a file's first bytes) starts an age file, binary or ASCII-armored. */
export function isAgeEncrypted(head: Uint8Array): boolean {
  const text = Buffer.from(head.subarray(0, AGE_ARMOR.length)).toString("latin1");
  return text.startsWith(AGE_MAGIC) || text.startsWith(AGE_ARMOR);
}
