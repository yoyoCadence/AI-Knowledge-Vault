import { describe, expect, it } from "vitest";
import { nextPollDelay } from "@/modules/jobs";

/**
 * The worker's poll schedule (ADR-024): fast while there is work or was some lately, then rare,
 * so a database that scales to zero (Neon, after 5 quiet minutes) can sleep.
 */
const base = {
  claimed: 0,
  canClaimMore: true,
  previousDelayMs: 1_000,
  sinceActivityMs: 0,
  pollIntervalMs: 1_000,
  fastMaxMs: 5_000,
  idlePollIntervalMs: 30 * 60_000,
  activeWindowMs: 120_000,
};

describe("nextPollDelay", () => {
  it("polls again at once after a claim that left capacity, else after the poll interval", () => {
    expect(nextPollDelay({ ...base, claimed: 2 })).toBe(0);
    expect(nextPollDelay({ ...base, claimed: 2, canClaimMore: false })).toBe(1_000);
    // A claim counts even when the worker was idle before.
    expect(nextPollDelay({ ...base, claimed: 1, sinceActivityMs: 10 * 60_000 })).toBe(0);
  });

  it("backs off from the poll interval to the fast maximum while active", () => {
    const delays: number[] = [];
    let previousDelayMs = base.pollIntervalMs;
    for (let poll = 0; poll < 6; poll += 1) {
      previousDelayMs = nextPollDelay({ ...base, previousDelayMs, sinceActivityMs: 60_000 });
      delays.push(previousDelayMs);
    }
    expect(delays).toEqual([1_500, 2_250, 3_375, 5_000, 5_000, 5_000]);
  });

  it("waits the idle interval once the active window has passed", () => {
    expect(nextPollDelay({ ...base, previousDelayMs: 5_000, sinceActivityMs: 120_000 })).toBe(
      30 * 60_000,
    );
    expect(nextPollDelay({ ...base, previousDelayMs: 5_000, sinceActivityMs: 119_999 })).toBe(
      5_000,
    );
  });

  it("starts the backoff over after a wake ends an idle wait", () => {
    expect(nextPollDelay({ ...base, previousDelayMs: 30 * 60_000, sinceActivityMs: 0 })).toBe(
      1_500,
    );
  });

  it("keeps today's schedule when no idle interval is configured", () => {
    // The default idle interval is the fast maximum: no idle mode, whatever the window says.
    expect(
      nextPollDelay({
        ...base,
        idlePollIntervalMs: 5_000,
        previousDelayMs: 5_000,
        sinceActivityMs: 60 * 60_000,
      }),
    ).toBe(5_000);
  });
});
