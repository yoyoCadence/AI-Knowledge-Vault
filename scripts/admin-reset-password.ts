/**
 * Sets a new password for an existing user and signs them out on every device, for an owner who
 * forgot theirs (there is no email reset):
 *
 *   ADMIN_EMAIL=me@example.com pnpm admin:reset-password
 *
 * Run it where the app's DATABASE_URL is set (for a deployment: `pnpm admin:reset-password:prod`
 * on the server). Like admin:create, the password is read from ADMIN_PASSWORD or prompted on the
 * TTY (input hidden), never from a command-line argument, which would leak through shell history
 * and `ps`. Audited as `auth.password.reset`.
 */
import { createInterface } from "node:readline";
import { Writable } from "node:stream";
import { getEnv } from "@/infrastructure/config/env";
import { closeDb, getDb } from "@/infrastructure/database/client";
import { isAppError } from "@/lib/errors";
import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH, resetPassword } from "@/modules/auth";

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
  const email = process.env.ADMIN_EMAIL ?? (await prompt("Email of the account: "));
  let password = process.env.ADMIN_PASSWORD;
  if (!password) {
    if (!process.stdin.isTTY) throw new Error("ADMIN_PASSWORD is required when stdin is not a TTY");
    password = await prompt(`New password (min ${MIN_PASSWORD_LENGTH} chars): `, true);
    const confirm = await prompt("Confirm password: ", true);
    if (password !== confirm) throw new Error("Passwords do not match");
  }

  if (password.length < MIN_PASSWORD_LENGTH || password.length > MAX_PASSWORD_LENGTH) {
    throw new Error(
      `Passwords are ${MIN_PASSWORD_LENGTH} to ${MAX_PASSWORD_LENGTH} characters long`,
    );
  }

  const result = await resetPassword(getDb(), { email, password });
  console.log(
    `Password reset for ${email.trim().toLowerCase()}; ${result.revokedSessions} session(s) signed out. Sign in with the new password.`,
  );
}

main()
  .catch((error: unknown) => {
    const message = isAppError(error) || error instanceof Error ? error.message : String(error);
    console.error(`admin:reset-password failed: ${message}`);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
