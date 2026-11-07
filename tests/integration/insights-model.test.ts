import { APICallError } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ModelUnavailable } from "@/server/db/insights";
import { createInsightsModel, type InsightsDeps } from "@/server/db/insights-model";
import { createModel, setRoute } from "@/server/db/llm-models";
import { reconcile } from "@/server/db/reconciler";
import { withTestDb, type TestDb } from "../support/db";

let db: TestDb;
const NOW = new Date("2026-11-04T10:00:00Z");
const caps = { structuredOutput: true, toolUse: false, vision: false, nativeWebSearch: false, contextWindow: 128000 };
const hosted = (over: Record<string, unknown> = {}) => ({
  provider: "anthropic",
  modelId: "m-1",
  label: "Cheap",
  baseUrl: null,
  prices: { inputPerMTokMicro: 3_000_000, outputPerMTokMicro: 15_000_000 },
  isFree: false,
  capabilities: caps,
  enabled: true,
  ...over,
});

beforeAll(async () => {
  db = await withTestDb();
});
afterAll(async () => {
  await db?.stop();
});
beforeEach(async () => {
  await db.reset();
  await db.ownerPool.query(await readFile("src/server/db/migrations/0005_settings.sql", "utf8")); // day and month caps
});

const usage = (i: number, o: number) => ({
  inputTokens: { total: i, noCache: i, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: o, text: o, reasoning: undefined },
});
const reply = (text: string, i = 400, o = 100) => ({ content: [{ type: "text", text }], finishReason: { unified: "stop", raw: "stop" }, usage: usage(i, o), warnings: [] }) as never;
const okModel = () => new MockLanguageModelV4({ doGenerate: reply('{"observations":["a"]}') });
const depsFor = (model: MockLanguageModelV4, over: Partial<InsightsDeps> = {}) => async (): Promise<InsightsDeps> => ({
  getKey: async () => "sk-test",
  buildModel: () => model,
  now: () => NOW,
  ...over,
});
const routed = async (over: Record<string, unknown> = {}) => {
  const m = await createModel(db.pool, hosted(over), { actor: "session" });
  await setRoute(db.pool, "titles", m.id, { actor: "session" });
  return m.id;
};
const one = async <T = Record<string, unknown>>(sql: string, args: unknown[] = []) => (await db.ownerPool.query(sql, args)).rows[0] as T;
const run = (model: ReturnType<typeof createInsightsModel>, kind: "review" | "optimizer" = "review", maxUsd = 0.2) => model.run({ kind, prompt: "numbers here", maxUsd });
const spent = async () => Number((await one<{ s: string }>("select coalesce(sum(spent_micro_usd),0) s from budgets")).s);
const reserved = async () => Number((await one<{ s: string }>("select coalesce(sum(reserved_micro_usd),0) s from budgets")).s);

describe("insights model", () => {
  it("skips_with_a_clear_message_when_no_model_is_routed", async () => {
    const m = okModel();
    await expect(run(createInsightsModel(db.pool, depsFor(m)))).rejects.toThrow(/Titles and insights/);
    await expect(run(createInsightsModel(db.pool, depsFor(m)))).rejects.toBeInstanceOf(ModelUnavailable);
    expect(m.doGenerateCalls).toHaveLength(0);
    expect(Number((await one<{ n: string }>("select count(*) n from spend_intents")).n)).toBe(0);
  });

  it("refuses_an_unpriced_model_before_anything_is_written_or_sent", async () => {
    // The database never lets an enabled model be unpriced, so it happens the other way: a free local model whose address
    // leaves the local-service list becomes unpriced again.
    await db.ownerPool.query("update settings set value = '[\"localhost:11434\"]'::jsonb where key = 'network.local_services'");
    await routed({ provider: "ollama", modelId: "q-7b", baseUrl: "http://localhost:11434/v1", prices: null, isFree: true });
    await db.ownerPool.query("update settings set value = '[]'::jsonb where key = 'network.local_services'");
    const m = okModel();
    await expect(run(createInsightsModel(db.pool, depsFor(m)))).rejects.toThrow(/no price/);
    expect(m.doGenerateCalls).toHaveLength(0);
    expect(Number((await one<{ n: string }>("select count(*) n from stage_runs")).n)).toBe(0);
  });

  it("refuses_a_disabled_model", async () => {
    const id = await routed();
    await db.ownerPool.query("update llm_models set enabled = false where id = $1", [id]);
    const m = okModel();
    await expect(run(createInsightsModel(db.pool, depsFor(m)))).rejects.toBeInstanceOf(ModelUnavailable);
    expect(m.doGenerateCalls).toHaveLength(0);
  });

  it("reserves_then_settles_the_real_cost_and_returns_the_text", async () => {
    await routed();
    const m = okModel();
    const out = await run(createInsightsModel(db.pool, depsFor(m)));
    expect(out.text).toBe('{"observations":["a"]}');
    // 400 in * 3 + 100 out * 15 = 2700 micro-USD
    expect(out.costUsd).toBeCloseTo(0.0027, 6);
    expect(await spent()).toBe(2700 * 3); // per-call scope, day and month copies
    expect(await reserved()).toBe(0);
    const it1 = await one<{ status: string; actual: string }>("select status, actual_micro_usd actual from spend_intents");
    expect(it1).toMatchObject({ status: "done", actual: "2700" });
    expect(m.doGenerateCalls).toHaveLength(1);
  });

  it("same_job_and_period_twice_calls_the_provider_once_and_pays_once", async () => {
    await routed();
    const m = okModel();
    const model = createInsightsModel(db.pool, depsFor(m));
    const a = await run(model);
    const b = await run(createInsightsModel(db.pool, depsFor(m))); // a second worker
    expect(b).toEqual(a);
    expect(m.doGenerateCalls).toHaveLength(1);
    expect(await spent()).toBe(2700 * 3);
    expect(Number((await one<{ n: string }>("select count(*) n from spend_intents")).n)).toBe(1);
  });

  it("a_later_period_is_a_new_call", async () => {
    await routed();
    const m = okModel();
    await run(createInsightsModel(db.pool, depsFor(m)));
    await run(createInsightsModel(db.pool, depsFor(m, { now: () => new Date("2026-11-12T10:00:00Z") })));
    expect(m.doGenerateCalls).toHaveLength(2);
  });

  it("refuses_before_the_call_when_the_worst_case_is_over_the_cap", async () => {
    await routed({ prices: { inputPerMTokMicro: 3_000_000, outputPerMTokMicro: 500_000_000 } }); // 1500 out tokens = 0.75 USD
    const m = okModel();
    await expect(run(createInsightsModel(db.pool, depsFor(m)))).rejects.toThrow(/over the 0.20 USD limit/);
    expect(m.doGenerateCalls).toHaveLength(0);
    expect(Number((await one<{ n: string }>("select count(*) n from spend_intents")).n)).toBe(0);
  });

  it("refuses_when_a_budget_is_used_up_and_leaves_nothing_reserved", async () => {
    await routed();
    await db.ownerPool.query("update budgets set cap_micro_usd = 0 where scope = 'day'");
    const m = okModel();
    await expect(run(createInsightsModel(db.pool, depsFor(m)))).rejects.toThrow(/spend limit/);
    expect(m.doGenerateCalls).toHaveLength(0);
    expect(await reserved()).toBe(0);
  });

  it("a_provider_refusal_releases_the_reservation_and_is_not_retried", async () => {
    await routed();
    const m = new MockLanguageModelV4({
      doGenerate: async () => {
        throw new APICallError({ message: "bad request", url: "https://a.b/c", requestBodyValues: {}, statusCode: 401 });
      },
    });
    await expect(run(createInsightsModel(db.pool, depsFor(m)))).rejects.toThrow(/nothing was charged/);
    expect(await reserved()).toBe(0);
    expect(await spent()).toBe(0);
    expect(await one<{ status: string }>("select status from spend_intents")).toEqual({ status: "failed_known" });
    await expect(run(createInsightsModel(db.pool, depsFor(m)))).rejects.toThrow(/already started/);
    expect(m.doGenerateCalls).toHaveLength(1);
  });

  it("an_unclear_outcome_keeps_the_reservation_and_never_repeats", async () => {
    await routed();
    const m = new MockLanguageModelV4({
      doGenerate: async () => {
        throw new Error("socket hang up");
      },
    });
    await expect(run(createInsightsModel(db.pool, depsFor(m)))).rejects.toThrow(/stays reserved/);
    expect(await reserved()).toBeGreaterThan(0);
    await expect(run(createInsightsModel(db.pool, depsFor(m)))).rejects.toBeInstanceOf(ModelUnavailable);
    expect(m.doGenerateCalls).toHaveLength(1);
  });

  it("the_reconciler_ends_an_abandoned_insights_stage_instead_of_queueing_it", async () => {
    await routed();
    await run(createInsightsModel(db.pool, depsFor(okModel())));
    await db.ownerPool.query("update stage_runs set status = 'running', lease_until = clock_timestamp() - interval '1 second'");
    const enqueued: string[] = [];
    const idle = { enqueue: async (id: string) => void enqueued.push(id), liveJobIds: async () => new Set<string>() };
    await reconcile(db.pool, idle as never, { graceMs: 0 });
    expect(enqueued).toEqual([]);
    expect((await one<{ status: string }>("select status from stage_runs")).status).toBe("failed");
  });
});
