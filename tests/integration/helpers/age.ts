import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

/** The reference age CLI, where it is installed; CI installs it (interoperability, ADR-022). */
export function ageCli(): string | null {
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

/** Decrypts `encrypted` with `age -d`, typing `passphrase` at its prompt; the SHA-256 of the output. */
export async function ageDecryptWithPassphrase(
  age: string,
  dir: string,
  encrypted: string,
  passphrase: string,
): Promise<string> {
  const script = path.join(dir, "type-at-prompt.py");
  const output = path.join(dir, `${path.basename(encrypted)}.decrypted`);
  await writeFile(script, TYPE_AT_PROMPT);
  execFileSync("python3", ["-I", script, age, output, encrypted], {
    env: { ...process.env, AGE_TEST_PASSPHRASE: passphrase },
    timeout: 60_000,
  });
  return createHash("sha256")
    .update(await readFile(output))
    .digest("hex");
}

/** Decrypts `encrypted` with `age -d -i identityFile`; the SHA-256 of the output. */
export async function ageDecryptWithIdentity(
  age: string,
  dir: string,
  encrypted: string,
  identityFile: string,
): Promise<string> {
  const output = path.join(dir, `${path.basename(encrypted)}.decrypted`);
  execFileSync(age, ["-d", "-i", identityFile, "-o", output, encrypted]);
  return createHash("sha256")
    .update(await readFile(output))
    .digest("hex");
}
