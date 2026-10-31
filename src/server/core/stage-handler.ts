import type { EngineConfig } from "./engine-config";
import { runPaidCall, type PaidCallOutput, type PaidCallPorts } from "./paid-call";
import type { StageClaim, StageLike } from "./stage-runner";

// The contract between the stage engine (stage-runner.ts) and a stage's own code. No IO here.
//
// A handler gets a StageContext and returns the stage result. Everything that costs money goes through ctx.paid,
// which is runPaidCall plus three things the handler cannot forget:
//   - a deterministic step index (0, 1, 2 ... per attempt), so the same handler run again after a crash produces the
//     same call keys and the stored results are replayed instead of paying again;
//   - an abort signal per call: it fires on stage cancel, lease loss, stage timeout, worker shutdown and on the
//     call's own provider timeout (default engine.timeout_stage_s);
//   - no new call starts once the stage signal has fired, and none starts after a provider timeout.
// When a call is abandoned (cancel/timeout) its intent is left PENDING (outcome unknown): the runner then parks the
// stage as needs_decision, never retries, and a late provider return is still settled (money is recorded).

export type AbortWhy = "cancel" | "stage_timeout" | "provider_timeout" | "lease_lost" | "shutdown";

// The reason carried by an AbortSignal (signal.reason) and thrown out of ctx.paid when a call is abandoned.
export class StageAbort extends Error {
  constructor(public readonly why: AbortWhy) {
    super(`stage aborted: ${why}`);
    this.name = "StageAbort";
  }
}

export interface PaidStep {
  reserveMicroUsd: number;
  budgetScopes: string[];
  kind: "paid" | "cheap_text";
  toolCallIndex?: number;
  timeoutMs?: number;
}

// Where ctx.log lines go (redacted file + live feed). Supplied by the worker; write never throws, close flushes.
export interface StageLogHandle {
  write(line: string): void;
  close(): Promise<void>;
}

export interface StageContext {
  stage: StageLike;
  claim: StageClaim;
  config: EngineConfig;
  signal: AbortSignal;
  attemptDir: string; // set by Task 10; "" until then
  progress?(percent: number): void; // live 0-100 on the video page; throttled, best effort; absent in fakes
  log(line: string): void; // redacted, compacted, capped; a no-op when the worker gives no log sink
  nextStep(): number;
  paid<T>(step: PaidStep, call: (key: string, signal: AbortSignal) => Promise<PaidCallOutput<T>>): Promise<T>;
}

// Throttle for progress writes: at most one per minMs, and only when the whole percent changed. Pure (clock injected).
export function makeProgressThrottle(write: (percent: number) => void, now: () => number = Date.now, minMs = 2000): (percent: number) => void {
  let lastPct = -1;
  let lastAt = -Infinity;
  return (percent) => {
    if (!Number.isFinite(percent)) return;
    const pct = Math.min(100, Math.max(0, Math.trunc(percent)));
    const t = now();
    if (pct === lastPct || t - lastAt < minMs) return;
    lastPct = pct;
    lastAt = t;
    write(pct);
  };
}

export type StageHandler = (ctx: StageContext) => Promise<unknown>;

export interface ContextInternals {
  ctx: StageContext;
  // Set once a provider call was abandoned by timeout: whatever the handler does next, the stage must park.
  providerTimedOut(): boolean;
}

export function createStageContext(args: {
  stage: StageLike;
  claim: StageClaim;
  config: EngineConfig;
  signal: AbortSignal;
  paid: PaidCallPorts;
  beforeCall?: () => Promise<void>;
  log?: (line: string) => void;
  writeProgress?: (percent: number) => Promise<void>;
}): ContextInternals {
  const { stage, claim, config, signal } = args;
  let step = 0;
  let timedOut = false;

  const ctx: StageContext = {
    stage,
    claim,
    config,
    signal,
    attemptDir: "",
    progress: makeProgressThrottle((pct) => {
      try { void args.writeProgress?.(pct).catch(() => {}); } catch { /* best effort */ }
    }),
    log: (line) => { try { args.log?.(line); } catch { /* a log must never fail the stage */ } },
    nextStep: () => step++,
    async paid<T>(s: PaidStep, call: (key: string, signal: AbortSignal) => Promise<PaidCallOutput<T>>): Promise<T> {
      if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new StageAbort("cancel");
      if (timedOut) throw new StageAbort("provider_timeout");
      const stepIndex = ctx.nextStep();
      const timeoutMs = s.timeoutMs ?? config.timeoutStageS * 1000;
      const callCtl = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const onStageAbort = () => callCtl.abort(signal.reason);
      signal.addEventListener("abort", onStageAbort, { once: true });
      // Rejects when the call is abandoned. The inner runPaidCall keeps going in the background: if the provider
      // does return, it still settles (late settle); if not, the intent stays pending.
      const abandoned = new Promise<never>((_, reject) => {
        callCtl.signal.addEventListener("abort", () => reject(callCtl.signal.reason), { once: true });
      });
      abandoned.catch(() => {});
      const inner = runPaidCall(
        args.paid,
        {
          claim,
          stepIndex,
          toolCallIndex: s.toolCallIndex ?? 0,
          reserveMicroUsd: s.reserveMicroUsd,
          budgetScopes: s.budgetScopes,
          kind: s.kind,
        },
        async (key) => {
          await args.beforeCall?.();
          // The reserve may have outlasted a cancel: never reach the provider with an already-abandoned signal.
          if (callCtl.signal.aborted) return Promise.reject(callCtl.signal.reason);
          timer = setTimeout(() => callCtl.abort(new StageAbort("provider_timeout")), timeoutMs);
          return call(key, callCtl.signal);
        },
      );
      inner.catch(() => {}); // an abandoned call's late failure must not become an unhandled rejection
      try {
        return await Promise.race([inner, abandoned]);
      } catch (err) {
        if (err instanceof StageAbort && err.why === "provider_timeout") timedOut = true;
        throw err;
      } finally {
        if (timer) clearTimeout(timer);
        signal.removeEventListener("abort", onStageAbort);
      }
    },
  };
  return { ctx, providerTimedOut: () => timedOut };
}
