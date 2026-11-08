import { describe, expect, it } from "vitest";
import { EnvValidationError, parseEnv } from "@/infrastructure/config/env";

const base = {
  APP_ORIGIN: "http://localhost:3000",
  PREVIEW_ORIGIN: "http://127.0.0.1:3000",
  DATABASE_URL: "postgres://u:p@localhost/db",
  BETTER_AUTH_SECRET: "a".repeat(40),
  PREVIEW_TOKEN_SECRET: "b".repeat(40),
  LOCAL_STORAGE_SIGNING_SECRET: "c".repeat(40),
};

function issuesOf(source: Record<string, string | undefined>): string[] {
  try {
    parseEnv(source);
    return [];
  } catch (error) {
    if (error instanceof EnvValidationError) return error.issues;
    throw error;
  }
}

describe("parseEnv", () => {
  it("accepts a valid development configuration and applies defaults", () => {
    const env = parseEnv(base);
    expect(env.STORAGE_DRIVER).toBe("local");
    expect(env.WORKER_CONCURRENCY).toBe(2);
    expect(env.APP_ORIGIN).toBe("http://localhost:3000");
  });

  it("normalizes origins and rejects identical app/preview origins", () => {
    expect(parseEnv({ ...base, APP_ORIGIN: "http://localhost:3000/some/path" }).APP_ORIGIN).toBe(
      "http://localhost:3000",
    );
    expect(issuesOf({ ...base, PREVIEW_ORIGIN: "http://localhost:3000" }).join()).toMatch(
      /PREVIEW_ORIGIN must be on another hostname/,
    );
  });

  it("puts the preview on a hostname of its own: cookies cross ports and schemes", () => {
    // RFC 6265: a cookie is sent to every port and scheme of its host, so another port is not
    // isolation for untrusted previews (ADR-007).
    for (const preview of [
      "http://localhost:3001",
      "https://localhost:3000",
      "http://LOCALHOST:3000",
    ]) {
      expect(issuesOf({ ...base, PREVIEW_ORIGIN: preview }).join(), preview).toMatch(
        /PREVIEW_ORIGIN must be on another hostname/,
      );
    }
    // A sibling or child hostname is fine: the app's cookies are host-only.
    expect(issuesOf({ ...base, PREVIEW_ORIGIN: "http://preview.localhost:3000" })).toEqual([]);
  });

  it("rejects short secrets without echoing their values", () => {
    const issues = issuesOf({ ...base, BETTER_AUTH_SECRET: "short-secret-value" });
    expect(issues.join()).toMatch(/BETTER_AUTH_SECRET must be at least 32/);
    expect(issues.join()).not.toContain("short-secret-value");
  });

  it("keeps the worker's polling unless an idle mode is configured, and guards the wake (ADR-024)", () => {
    const env = parseEnv(base);
    expect(env.WORKER_IDLE_POLL_INTERVAL_MS).toBe(5_000);
    expect(env.WORKER_HEALTH_HOST).toBe("127.0.0.1");
    expect(env.WORKER_WAKE_URL).toBeUndefined();

    const wakeUrl = "http://worker.railway.internal:3901/wake";
    expect(issuesOf({ ...base, WORKER_WAKE_URL: wakeUrl }).join("\n")).toMatch(
      /WORKER_WAKE_SECRET .*required when WORKER_WAKE_URL is set/,
    );
    expect(issuesOf({ ...base, WORKER_WAKE_SECRET: "short" }).join("\n")).toMatch(
      /WORKER_WAKE_SECRET must be at least 32 characters/,
    );
    // Not the same value as another secret.
    expect(issuesOf({ ...base, WORKER_WAKE_SECRET: "a".repeat(40) }).join("\n")).toMatch(
      /secrets must be distinct/,
    );
    const configured = parseEnv({
      ...base,
      WORKER_IDLE_POLL_INTERVAL_MS: "1800000",
      WORKER_HEALTH_HOST: "::",
      WORKER_WAKE_URL: wakeUrl,
      WORKER_WAKE_SECRET: "d".repeat(40),
    });
    expect(configured).toMatchObject({
      WORKER_IDLE_POLL_INTERVAL_MS: 1_800_000,
      WORKER_HEALTH_HOST: "::",
      WORKER_WAKE_URL: wakeUrl,
    });
  });

  it("rejects reused secrets", () => {
    expect(issuesOf({ ...base, PREVIEW_TOKEN_SECRET: base.BETTER_AUTH_SECRET }).join()).toMatch(
      /distinct/,
    );
  });

  it("refuses local storage in production unless explicitly allowed (ADR-006)", () => {
    const prod = {
      ...base,
      APP_ENV: "production",
      APP_ORIGIN: "https://vault.example.com",
      PREVIEW_ORIGIN: "https://p.example.net",
    };
    expect(issuesOf(prod).join()).toMatch(/local storage is refused/);
    expect(issuesOf({ ...prod, ALLOW_LOCAL_STORAGE_IN_PRODUCTION: "true" })).toEqual([]);
  });

  it("requires an explicit APP_ENV when NODE_ENV=production", () => {
    // Otherwise a deployment that forgot APP_ENV would skip every production check.
    expect(issuesOf({ ...base, NODE_ENV: "production" }).join()).toMatch(/APP_ENV is required/);
    expect(parseEnv({ ...base, NODE_ENV: "production", APP_ENV: "test" }).APP_ENV).toBe("test");
    expect(parseEnv(base).APP_ENV).toBe("development");
  });

  it("requires https origins in production", () => {
    const issues = issuesOf({
      ...base,
      APP_ENV: "production",
      ALLOW_LOCAL_STORAGE_IN_PRODUCTION: "true",
    });
    expect(issues.join()).toMatch(/APP_ORIGIN: APP_ORIGIN must use https/);
  });

  it("requires S3 settings when STORAGE_DRIVER=s3", () => {
    const issues = issuesOf({ ...base, STORAGE_DRIVER: "s3" });
    expect(issues.join()).toMatch(/S3_BUCKET is required/);
    expect(issues.join()).toMatch(/S3_SECRET_ACCESS_KEY is required/);
  });
});
