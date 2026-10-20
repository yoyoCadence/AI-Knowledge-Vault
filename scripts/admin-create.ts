/**
 * Creates the initial administrator, their workspace and owner membership (FR-AUTH-1).
 *
 *   ADMIN_EMAIL=me@example.com ADMIN_NAME="Me" pnpm admin:create
 *
 * The password is read from ADMIN_PASSWORD or prompted on the TTY (input hidden). It is never
 * accepted as a command-line argument, which would leak through shell history and `ps`.
 */
import { createInterface } from "node:readline";
import { Writable } from "node:stream";
import { getEnv } from "@/infrastructure/config/env";
import { closeDb, getDb } from "@/infrastructure/database/client";
import { isAppError } from "@/lib/errors";
import { createAdmin, MIN_PASSWORD_LENGTH } from "@/modules/auth";

function prompt(question: string, hidden = false): Promise<string> {
  let muted = false;
  const output = new Writable({
    write(chunk, _encoding, callback) {
      if (!muted) process.stdout.write(chunk);
      callback();
    },
  });
  const rl = createInterface({ input: process.stdin, output, terminal: true });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      if (hidden) process.stdout.write("\n");
      resolve(answer.trim());
    });
    muted = hidden;
  });
}

async function main(): Promise<void> {
  getEnv(); // validate configuration first
  const email = process.env.ADMIN_EMAIL ?? (await prompt("Admin email: "));
  const name = process.env.ADMIN_NAME ?? ((await prompt("Display name [Admin]: ")) || "Admin");
  let password = process.env.ADMIN_PASSWORD;
  if (!password) {
    if (!process.stdin.isTTY) throw new Error("ADMIN_PASSWORD is required when stdin is not a TTY");
    password = await prompt(`Password (min ${MIN_PASSWORD_LENGTH} chars): `, true);
    const confirm = await prompt("Confirm password: ", true);
    if (password !== confirm) throw new Error("Passwords do not match");
  }

  const result = await createAdmin(getDb(), { email, name, password });
  console.log(`Created admin ${email} with workspace "${result.workspaceSlug}".`);
}

main()
  .catch((error: unknown) => {
    const message = isAppError(error) || error instanceof Error ? error.message : String(error);
    console.error(`admin:create failed: ${message}`);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
