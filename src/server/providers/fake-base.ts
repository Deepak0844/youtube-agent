import type pg from "pg";
import { KnownFailure } from "@/server/core/paid-call";

// Shared engine for the deterministic provider fakes (voice, image, renderer, uploader). Same Outcome shape as
// tests/support/fake-provider.ts. Each fake plays a script in order (the last outcome repeats; an empty script
// succeeds with the fake's own default), counts calls in memory and, when given a pool, in the independent
// fake_provider_calls table (created by the test harness, not by a product migration).

export type Outcome =
  | { kind: "ok"; actualMicroUsd: number; result?: unknown }
  | { kind: "known_failure"; message?: string }
  | { kind: "throws_unknown"; message?: string }
  | { kind: "hangs"; ms: number; then: Outcome };

export const ok = (actualMicroUsd: number, result?: unknown): Outcome => ({ kind: "ok", actualMicroUsd, result });
export const knownFailure = (message = "provider rejected"): Outcome => ({ kind: "known_failure", message });
export const throwsUnknown = (message = "socket hang up"): Outcome => ({ kind: "throws_unknown", message });
export const hangs = (ms: number, then: Outcome = ok(1)): Outcome => ({ kind: "hangs", ms, then });

export interface FakeOptions {
  pool?: pg.Pool;
  script?: Outcome[];
}

export interface FakeCounters {
  calls: Map<string, number>;
  totalCalls(): number;
  dbCalls(callKey: string): Promise<number>;
}

export interface Played {
  actualMicroUsd: number;
  result: unknown; // undefined means "use the fake's default result"
}

export interface Script extends FakeCounters {
  /** Counts the call, then plays the next scripted outcome. Throws KnownFailure / Error / abort reason as scripted. */
  play(callKey: string, signal: AbortSignal | undefined, defaults: { actualMicroUsd: number }): Promise<Played>;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(signal!.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function createScript(opts: FakeOptions = {}): Script {
  const calls = new Map<string, number>();
  let n = 0;

  async function run(o: Outcome, signal: AbortSignal | undefined): Promise<Played> {
    switch (o.kind) {
      case "ok":
        return { actualMicroUsd: o.actualMicroUsd, result: o.result };
      case "known_failure":
        throw new KnownFailure(o.message ?? "known failure");
      case "throws_unknown":
        throw new Error(o.message ?? "unknown failure");
      case "hangs":
        await sleep(o.ms, signal);
        return run(o.then, signal);
    }
  }

  return {
    calls,
    totalCalls: () => [...calls.values()].reduce((a, b) => a + b, 0),
    async dbCalls(callKey) {
      if (!opts.pool) throw new Error("dbCalls needs a pool");
      const { rows } = await opts.pool.query("select count(*)::int as n from fake_provider_calls where call_key = $1", [callKey]);
      return rows[0].n as number;
    },
    async play(callKey, signal, defaults) {
      calls.set(callKey, (calls.get(callKey) ?? 0) + 1);
      if (opts.pool) await opts.pool.query("insert into fake_provider_calls (call_key) values ($1)", [callKey]);
      const s = opts.script ?? [];
      const o = s.length ? s[Math.min(n, s.length - 1)]! : ok(defaults.actualMicroUsd);
      n += 1;
      return run(o, signal);
    },
  };
}
