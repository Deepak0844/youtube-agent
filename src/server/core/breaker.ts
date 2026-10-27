// Pure circuit-breaker rules (old agent/jobs.py breaker, Doc 02 4.7). The database layer supplies the clock.
export type BreakerEvent = "failure" | "success" | "reset";
export interface BreakerState {
  status: "closed" | "open" | "half_open";
  failures: number;
  openedAtMs: number | null;
}
export interface BreakerConfig {
  threshold: number; // consecutive failures that open it; 0 turns the breaker off
  cooldownMs: number;
}
export const CLOSED: BreakerState = { status: "closed", failures: 0, openedAtMs: null };

// An open breaker whose cooldown has passed is half open: one stage may go through to test.
function effective(s: BreakerState, nowMs: number, cfg: BreakerConfig): BreakerState {
  if (s.status === "open" && s.openedAtMs !== null && nowMs - s.openedAtMs >= cfg.cooldownMs) return { ...s, status: "half_open" };
  return s;
}

export function breakerAllows(state: BreakerState, nowMs: number, cfg: BreakerConfig): boolean {
  if (cfg.threshold <= 0) return true;
  return effective(state, nowMs, cfg).status !== "open";
}

/**
 * Admission for ONE new stage. Closed: pass. Open: hold. Half open: exactly one stage (the probe) passes; the rest hold
 * until the probe reports or, if its outcome never arrives (cancelled, parked), one more cooldown has passed.
 */
export function admitBreaker(state: BreakerState, probeAtMs: number | null, nowMs: number, cfg: BreakerConfig): { allowed: boolean; takesProbe: boolean } {
  if (cfg.threshold <= 0) return { allowed: true, takesProbe: false };
  const s = effective(state, nowMs, cfg);
  if (s.status === "closed") return { allowed: true, takesProbe: false };
  if (s.status === "open") return { allowed: false, takesProbe: false };
  if (probeAtMs === null || nowMs - probeAtMs >= cfg.cooldownMs) return { allowed: true, takesProbe: true };
  return { allowed: false, takesProbe: false };
}

/** When the next stage may pass (ms), or null when one may pass now. For the "paused until" text. */
export function holdUntilMs(state: BreakerState, probeAtMs: number | null, nowMs: number, cfg: BreakerConfig): number | null {
  if (cfg.threshold <= 0) return null;
  const s = effective(state, nowMs, cfg);
  if (s.status === "closed") return null;
  if (s.status === "open") return (s.openedAtMs ?? nowMs) + cfg.cooldownMs;
  if (probeAtMs === null || nowMs - probeAtMs >= cfg.cooldownMs) return null;
  return probeAtMs + cfg.cooldownMs;
}

export function breakerStep(state: BreakerState, event: BreakerEvent, nowMs: number, cfg: BreakerConfig): BreakerState {
  if (event === "reset" || event === "success") return CLOSED;
  if (cfg.threshold <= 0) return CLOSED;
  const s = effective(state, nowMs, cfg);
  if (s.status === "open") return s; // already holding; a straggler failure does not extend the cooldown
  const failures = s.failures + 1;
  if (s.status === "half_open" || failures >= cfg.threshold) return { status: "open", failures, openedAtMs: nowMs };
  return { status: "closed", failures, openedAtMs: null };
}
