import { nextBackoffMs, type ErrorClass } from "./error-class";

// Pure retry rule. Owner rule: only a CLEAR provider rejection (class "transient", see error-class.ts) is ever retried;
// permanent and unknown outcomes never are, however many attempts are left.
//
// `attemptsSoFar` counts every try of this stage so far (the original plus earlier retries). `maxAttempts` is
// engine.retry_attempts and is the TOTAL number of tries. Retry number n (1 = first retry) waits schedule[n - 1].
export type RetryDecision = { kind: "retry"; delayMs: number } | { kind: "stop"; reason: "not_transient" | "exhausted" };

export function retryDecision(a: { errorClass: ErrorClass | undefined; attemptsSoFar: number; maxAttempts: number; schedule: readonly number[] }): RetryDecision {
  if (a.errorClass !== "transient") return { kind: "stop", reason: "not_transient" };
  if (!Number.isInteger(a.attemptsSoFar) || a.attemptsSoFar < 1 || a.attemptsSoFar >= a.maxAttempts) return { kind: "stop", reason: "exhausted" };
  const delayMs = nextBackoffMs(a.attemptsSoFar - 1, a.schedule);
  return delayMs === null ? { kind: "stop", reason: "exhausted" } : { kind: "retry", delayMs };
}
