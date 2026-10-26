import type pg from "pg";
import { KnownFailure } from "@/server/core/paid-call";

export type Outcome =
  | { kind: "ok"; actualMicroUsd: number; result: unknown }
  | { kind: "known_failure"; message?: string }
  | { kind: "throws_unknown"; message?: string }
  | { kind: "hangs"; ms: number; then: Outcome };

export const ok = (actualMicroUsd: number, result: unknown = { text: "ok" }): Outcome => ({ kind: "ok", actualMicroUsd, result });
export const knownFailure = (message = "provider rejected"): Outcome => ({ kind: "known_failure", message });
export const throwsUnknown = (message = "socket hang up"): Outcome => ({ kind: "throws_unknown", message });
export const hangs = (ms: number, then: Outcome = ok(1)): Outcome => ({ kind: "hangs", ms, then });

export interface FakeProvider {
  calls: Map<string, number>;
  totalCalls(): number;
  // Counts survive a killed child process because each call is also inserted into Postgres.
  dbCalls(callKey: string): Promise<number>;
  // Creates the fake_provider_calls table (test helper only; not part of the product migration).
  init(): Promise<void>;
  call(idempotencyKey: string): Promise<{ result: unknown; actualMicroUsd: number; providerRef: string }>;
}

// script: per call key, outcomes consumed in order (the last one repeats); keys without a script succeed with ok(1).
export function createFakeProvider(opts: { pool?: pg.Pool; script?: Record<string, Outcome | Outcome[]> } = {}): FakeProvider {
  const calls = new Map<string, number>();
  const nth = new Map<string, number>();

  async function play(o: Outcome, key: string): Promise<{ result: unknown; actualMicroUsd: number; providerRef: string }> {
    switch (o.kind) {
      case "ok":
        return { result: o.result, actualMicroUsd: o.actualMicroUsd, providerRef: `ref:${key}` };
      case "known_failure":
        throw new KnownFailure(o.message ?? "known failure");
      case "throws_unknown":
        throw new Error(o.message ?? "unknown failure");
      case "hangs":
        await new Promise((r) => setTimeout(r, o.ms));
        return play(o.then, key);
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
    async init() {
      if (!opts.pool) return;
      // The table is created by withTestDb as the owner (the app role may not run DDL); this only checks it is there.
      await opts.pool.query("select 1 from fake_provider_calls limit 0");
    },
    async call(key) {
      calls.set(key, (calls.get(key) ?? 0) + 1);
      if (opts.pool) await opts.pool.query("insert into fake_provider_calls (call_key) values ($1)", [key]);
      const s = opts.script?.[key];
      const i = nth.get(key) ?? 0;
      nth.set(key, i + 1);
      const outcome = Array.isArray(s) ? s[Math.min(i, s.length - 1)]! : (s ?? ok(1));
      return play(outcome, key);
    },
  };
}
