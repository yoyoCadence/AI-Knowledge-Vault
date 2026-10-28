import { rmSync } from "node:fs";
import { constants } from "node:os";

/**
 * Paths an operator CLI must not leave behind if it is interrupted: a decrypted archive's
 * directory, the files of an unfinished export, a restore's extraction directory. On SIGINT,
 * SIGTERM and SIGHUP, Node exits without running `finally` blocks, so a CLI calls
 * `cleanUpOnInterrupt()` once: those signals then remove every path still registered,
 * synchronously, and exit with 128 + the signal's number. The web server and the worker handle
 * their own signals and never install these handlers; registering a path there is harmless.
 * SIGKILL, a power cut or a crash can still leave a path behind (in TMPDIR, or at `--out`).
 */
const pending = new Set<string>();
let installed = false;

/** Registers `target` for removal on interrupt; the returned function unregisters it. */
export function removeIfInterrupted(target: string): () => void {
  pending.add(target);
  return () => {
    pending.delete(target);
  };
}

/** Installs the SIGINT, SIGTERM and SIGHUP handlers (once per process). */
export function cleanUpOnInterrupt(): void {
  if (installed) return;
  installed = true;
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(signal, () => {
      for (const target of pending) {
        try {
          rmSync(target, { recursive: true, force: true });
        } catch {
          // Nothing more can be done while exiting; the others are still removed.
        }
      }
      process.exit(128 + constants.signals[signal]);
    });
  }
}
