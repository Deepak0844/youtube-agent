import { KnownFailure } from "./paid-call";

// Owner decision: an unclear outcome is NEVER retried (it may have been charged). Only a clear provider rejection, one the
// provider layer itself marks as "nothing was processed", is retried, on a fixed back-off.
export type ErrorClass = "transient" | "permanent" | "unknown";

/**
 * Thrown by a provider adapter that SAW the provider refuse the request before processing it (HTTP status line received
 * with no work done, or connect/DNS failure before any byte was sent). Being a KnownFailure, it also settles the paid call
 * as "not charged". Nothing else carries this mark; a lookalike object or a bare `status` field does not count.
 */
export class NotProcessedError extends KnownFailure {
  readonly status: number | undefined;
  readonly code: string | undefined;
  constructor(message: string, detail: { status?: number; code?: string } = {}) {
    super(message);
    this.name = "NotProcessedError";
    this.status = detail.status;
    this.code = detail.code;
  }
}

const BEFORE_SEND_CODES = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN"]);

export function classifyError(err: unknown): ErrorClass {
  if (!(err instanceof NotProcessedError)) return "unknown";
  const { status, code } = err;
  if (status !== undefined) {
    // Only 429 is a refusal the provider makes BEFORE doing work. 408 and 5xx can come after the work started (a gateway
    // that timed out while the provider kept going), so they are unclear and never retried.
    if (status === 429) return "transient";
    if (status === 408 || (status >= 500 && status <= 599)) return "unknown";
    if (status >= 400 && status <= 499) return "permanent";
    return "unknown";
  }
  if (code !== undefined && BEFORE_SEND_CODES.has(code)) return "transient";
  return "permanent"; // refused with no retry-worthy signal: do not retry
}

/** Wait before retry number `attemptIndex` (0 = first retry), in ms; null when the schedule is used up. */
export function nextBackoffMs(attemptIndex: number, schedule: readonly number[]): number | null {
  if (!Number.isInteger(attemptIndex) || attemptIndex < 0 || attemptIndex >= schedule.length) return null;
  return schedule[attemptIndex]! * 1000;
}
