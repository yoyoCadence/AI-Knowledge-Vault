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
      /PREVIEW_ORIGIN must differ/,
    );
  });

  it("rejects short secrets without echoing their values", () => {
    const issues = issuesOf({ ...base, BETTER_AUTH_SECRET: "short-secret-value" });
    expect(issues.join()).toMatch(/BETTER_AUTH_SECRET must be at least 32/);
    expect(issues.join()).not.toContain("short-secret-value");
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
