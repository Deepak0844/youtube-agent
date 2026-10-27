import type { LanguageModel } from "ai";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import type { Message, ModelStep, StepResult } from "@/server/core/agent-loop";
import { NotProcessedError } from "@/server/core/error-class";
import { priceCardFor, type ModelRow } from "@/server/core/llm-catalog";
import { BudgetRefusedError, KnownFailure, NeedsDecisionError, runPaidCall, type PaidCallOutput } from "@/server/core/paid-call";
import { uuidv7 } from "@/server/core/ids";
import { worstCaseMicroUsd } from "@/server/core/spend";
import { createPgPaidCallPorts } from "@/server/db/paid-call-adapter";
import { claimStage, insertQueuedStage, type Claim } from "@/server/db/stages";
import { createLlmClient, type LlmCatalog, type LlmStageContext } from "@/server/llm/client";
import { withTestDb, type TestDb } from "../support/db";

// LlmClient on the real paid-call path: real Postgres reservations, call keys and settle.
let db: TestDb;
beforeAll(async () => {
  db = await withTestDb();
});
afterAll(async () => {
  await db?.stop();
});
beforeEach(async () => {
  await db.reset();
  await db.pool.query("insert into budgets (scope, cap_micro_usd) values ('s', 100000)");
});

const caps = { structuredOutput: true, toolUse: true, vision: false, nativeWebSearch: false, contextWindow: 128000 };
const model: ModelRow = {
  id: "00000000-0000-4000-8000-000000000001",
  provider: "anthropic",
  modelId: "m-1",
  label: "Paid one",
  baseUrl: null,
  prices: { inputPerMTokMicro: 3_000_000, outputPerMTokMicro: 15_000_000 },
  isFree: false,
  capabilities: caps,
  enabled: true,
  endpointKind: "hosted",
};
const catalog: LlmCatalog = { route: async () => model, localServices: async () => [] };
const schema = z.strictObject({ n: z.number() });
const msgs: Message[] = [{ role: "user", content: "go" }];
const ans = (text: string, i = 100, o = 10): StepResult => ({ text, toolCalls: [], usage: { inputTokens: i, outputTokens: o } });

async function stageClaim(): Promise<Claim> {
  const id = await insertQueuedStage(db.pool, { videoId: uuidv7(), name: "draft", inputHash: "h" });
  const c = await claimStage(db.pool, { id, inputHash: "h", workerId: "w1", ttlMs: 60_000 });
  if (!c) throw new Error("claim failed");
  return c;
}
// A ctx.paid like the engine's: step numbers from a counter that restarts on every "process", real runPaidCall underneath.
function ctxFor(claim: Claim): LlmStageContext {
  const ports = createPgPaidCallPorts(db.pool);
  let step = 0;
  return {
    signal: new AbortController().signal,
    paid: <T,>(s: { reserveMicroUsd: number; budgetScopes: string[]; kind: "paid" | "cheap_text" }, call: (key: string, signal: AbortSignal) => Promise<PaidCallOutput<T>>) =>
      runPaidCall(ports, { claim, stepIndex: step++, toolCallIndex: 0, reserveMicroUsd: s.reserveMicroUsd, budgetScopes: s.budgetScopes, kind: s.kind }, (key) => call(key, new AbortController().signal)),
  };
}
function clientWith(script: Array<StepResult | Error>, log: { calls: number } = { calls: 0 }) {
  const makeStep = (): ModelStep => async () => {
    log.calls++;
    const next = script.shift();
    if (!next) throw new Error("script exhausted");
    if (next instanceof Error) throw next;
    return next;
  };
  return createLlmClient({ db: undefined as never, catalog, getKey: async () => null, buildModel: () => ({}) as LanguageModel, budgetScopes: () => ["s"], makeStep });
}
const cost = (i: number, o: number) => worstCaseMicroUsd(priceCardFor(model, [])!, { inputTokens: i, maxOutputTokens: o });
const budget = async () => (await db.pool.query("select reserved_micro_usd r, spent_micro_usd s from budgets where scope = 's'")).rows[0] as { r: string; s: string };
const intents = async () => (await db.pool.query("select call_key, status, reserved_micro_usd r, actual_micro_usd a from spend_intents order by step_index")).rows;
const gen = (c: ReturnType<typeof clientWith>, ctx: LlmStageContext) => c.generate(ctx, { stage: "draft", schema, messages: msgs, maxOutputTokens: 400 });

describe("LlmClient on the real spend path", () => {
  it("every_retry_is_its_own_intent_reserved_and_settled_so_nothing_is_hidden", async () => {
    const claim = await stageClaim();
    const r = await gen(clientWith([ans("nope", 100, 10), ans('{"n":1}', 150, 12)]), ctxFor(claim));
    expect(r.value.n).toBe(1);
    const rows = await intents();
    expect(rows.map((x) => x.status)).toEqual(["done", "done"]);
    expect(rows.map((x) => x.call_key)).toEqual([`${claim.stageRunId}:0:0`, `${claim.stageRunId}:1:0`]);
    expect(rows.map((x) => Number(x.a))).toEqual([cost(100, 10), cost(150, 12)]);
    expect(Number(rows[1]!.r)).toBeGreaterThan(Number(rows[0]!.r));
    expect(await budget()).toEqual({ r: "0", s: String(r.spentMicroUsd) });
  });

  it("retry_cap_two_then_known_failure_with_spend_counted_in_the_ledger", async () => {
    const claim = await stageClaim();
    const log = { calls: 0 };
    const err = await gen(clientWith([ans("a"), ans("b"), ans("c"), ans('{"n":1}')], log), ctxFor(claim)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(KnownFailure);
    expect(log.calls).toBe(3);
    expect((await intents()).map((x) => x.status)).toEqual(["done", "done", "done"]);
    expect(Number((await budget()).s)).toBe(3 * cost(100, 10));
  });

  it("the_cap_stops_a_retry_before_the_provider_is_called", async () => {
    const claim = await stageClaim();
    const first = cost(100, 10);
    const oneReserve = worstCaseMicroUsd(priceCardFor(model, [])!, { inputTokens: 20, maxOutputTokens: 400 }); // ~6 KB worst case
    await db.pool.query("update budgets set cap_micro_usd = $1 where scope = 's'", [oneReserve + first + 1]); // room for try 1, not for a second reservation
    const log = { calls: 0 };
    await expect(gen(clientWith([ans("bad"), ans('{"n":1}')], log), ctxFor(claim))).rejects.toBeInstanceOf(BudgetRefusedError);
    expect(log.calls).toBe(1); // the refused retry never reached the provider
    expect((await budget()).r).toBe("0");
    expect(Number((await budget()).s)).toBe(first); // the first try's real cost stays counted
  });

  it("generate_resumes_after_crash_with_zero_provider_calls_when_done", async () => {
    const claim = await stageClaim();
    const log = { calls: 0 };
    const first = await gen(clientWith([ans("bad"), ans('{"n":2}', 130, 9)], log), ctxFor(claim));
    expect(log.calls).toBe(2);
    const again = await gen(clientWith([], log), ctxFor(claim)); // new process: step counter back at 0, empty script
    expect(log.calls).toBe(2);
    expect(again).toEqual(first);
    expect(Number((await budget()).s)).toBe(first.spentMicroUsd); // not charged twice
  });

  it("an_unclear_try_is_never_repeated_the_resume_parks_the_stage", async () => {
    const claim = await stageClaim();
    const log = { calls: 0 };
    await expect(gen(clientWith([ans("bad"), new Error("The provider answered with an error (503).")], log), ctxFor(claim))).rejects.toThrow(/503/);
    expect(log.calls).toBe(2);
    // the resume replays try 0 for free, finds try 1 with an open intent, and parks instead of calling again
    const resumed = gen(clientWith([ans('{"n":1}')], log), ctxFor(claim));
    await expect(resumed).rejects.toBeInstanceOf(NeedsDecisionError);
    expect(log.calls).toBe(2);
    expect((await db.pool.query("select status from stage_runs where id = $1", [claim.stageRunId])).rows[0].status).toBe("needs_decision");
  });

  it("a_clear_provider_refusal_releases_the_reservation", async () => {
    const claim = await stageClaim();
    // the step maps a real 4xx to NotProcessedError (a KnownFailure)
    await expect(gen(clientWith([new NotProcessedError("The provider rejected the request (400).", { status: 400 })]), ctxFor(claim))).rejects.toBeInstanceOf(KnownFailure);
    expect(await budget()).toEqual({ r: "0", s: "0" });
    expect((await intents())[0]!.status).toBe("failed_known");
  });
});
