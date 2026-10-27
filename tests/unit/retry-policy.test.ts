import { describe, expect, it } from "vitest";
import { retryDecision } from "@/server/core/retry-policy";

const schedule = [30, 120, 480];
const d = (over: Partial<Parameters<typeof retryDecision>[0]> = {}) => retryDecision({ errorClass: "transient", attemptsSoFar: 1, maxAttempts: 4, schedule, ...over });

describe("retry policy", () => {
  it("waits 30, 120, 480 seconds for retries 1, 2, 3", () => {
    expect(d({ attemptsSoFar: 1 })).toEqual({ kind: "retry", delayMs: 30_000 });
    expect(d({ attemptsSoFar: 2 })).toEqual({ kind: "retry", delayMs: 120_000 });
    expect(d({ attemptsSoFar: 3 })).toEqual({ kind: "retry", delayMs: 480_000 });
  });
  it("stops when attempts are used up", () => {
    expect(d({ attemptsSoFar: 4 })).toEqual({ kind: "stop", reason: "exhausted" });
    expect(d({ attemptsSoFar: 3, maxAttempts: 3 })).toEqual({ kind: "stop", reason: "exhausted" });
  });
  it("never retries permanent or unknown outcomes, however many attempts are left", () => {
    expect(d({ errorClass: "permanent" })).toEqual({ kind: "stop", reason: "not_transient" });
    expect(d({ errorClass: "unknown" })).toEqual({ kind: "stop", reason: "not_transient" });
    expect(d({ errorClass: undefined })).toEqual({ kind: "stop", reason: "not_transient" });
  });
  it("a schedule shorter than the attempts stops instead of inventing a wait", () => {
    expect(d({ attemptsSoFar: 2, schedule: [30] })).toEqual({ kind: "stop", reason: "exhausted" });
  });
  it("rejects nonsense counts", () => {
    expect(d({ attemptsSoFar: 0 })).toEqual({ kind: "stop", reason: "exhausted" });
    expect(d({ attemptsSoFar: 1.5 })).toEqual({ kind: "stop", reason: "exhausted" });
  });
});
