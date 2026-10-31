import type { LanguageModel } from "ai";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { estimateInputTokens, type Message, type ModelStep, type StepResult } from "@/server/core/agent-loop";
import { KnownFailure } from "@/server/core/paid-call";
import { priceCardFor, type ModelRow } from "@/server/core/llm-catalog";
import { worstCaseMicroUsd } from "@/server/core/spend";
import { createLlmClient, LlmRefusal, type LlmCatalog, type LlmStageContext } from "@/server/llm/client";

const caps = { structuredOutput: true, toolUse: true, vision: false, nativeWebSearch: false, contextWindow: 128000 };
const PRICE = { inputPerMTokMicro: 3_000_000, outputPerMTokMicro: 15_000_000 };
const mk = (over: Partial<ModelRow> = {}): ModelRow => ({
  id: "00000000-0000-4000-8000-000000000001",
  provider: "anthropic",
  modelId: "m-1",
  label: "Paid one",
  baseUrl: null,
  prices: PRICE,
  isFree: false,
  capabilities: caps,
  enabled: true,
  endpointKind: "hosted",
  ...over,
});

// In-memory stand-in for ctx.paid: numbers steps like the real one, keeps finished results by step number so a "resumed"
// context (same ledger, counter back at 0) gets them back without calling the provider.
interface Ledger {
  done: Map<number, unknown>;
  reserves: { step: number; reserveMicroUsd: number; budgetScopes: string[] }[];
  spent: number;
}
const newLedger = (): Ledger => ({ done: new Map(), reserves: [], spent: 0 });
function ctxOn(ledger: Ledger): LlmStageContext {
  let n = 0;
  return {
    signal: new AbortController().signal,
    async paid(step, call) {
      const i = n++;
      ledger.reserves.push({ step: i, reserveMicroUsd: step.reserveMicroUsd, budgetScopes: step.budgetScopes });
      if (ledger.done.has(i)) return ledger.done.get(i) as never;
      const out = await call(`key:${i}`, new AbortController().signal);
      ledger.done.set(i, JSON.parse(JSON.stringify(out.result)));
      ledger.spent += out.actualMicroUsd;
      return out.result;
    },
  };
}

const answer = (text: string, inTok = 100, outTok = 20): StepResult => ({ text, toolCalls: [], usage: { inputTokens: inTok, outputTokens: outTok } });

function setup(opts: { models?: ModelRow[]; routes?: Record<string, string>; script?: Array<StepResult | Error>; local?: string[] } = {}) {
  const models = opts.models ?? [mk()];
  const routes = opts.routes ?? { draft: models[0]!.id, outline: models[0]!.id };
  const script = opts.script ?? [];
  const seen: { messages: Message[]; key: string }[] = [];
  const built: string[] = [];
  const catalog: LlmCatalog = {
    route: async (stage) => models.find((m) => m.id === routes[stage]),
    localServices: async () => opts.local ?? [],
  };
  const makeStep = (): ModelStep => async (messages, key) => {
    seen.push({ messages: [...messages], key });
    const next = script.shift();
    if (!next) throw new Error("script exhausted");
    if (next instanceof Error) throw next;
    return next;
  };
  const client = createLlmClient({
    db: undefined as never,
    catalog,
    getKey: async () => "never-used-here",
    buildModel: (row) => {
      built.push(row.id);
      return {} as LanguageModel;
    },
    budgetScopes: () => ["video:scene_kit", "day", "month", "draft_run"],
    makeStep,
  });
  return { client, seen, built, models };
}

const schema = z.strictObject({ title: z.string().min(1), n: z.number().int() });
const good = JSON.stringify({ title: "hello", n: 3 });
const msgs: Message[] = [{ role: "system", content: "JSON only." }, { role: "user", content: "make one" }];
const gen = (c: ReturnType<typeof setup>["client"], ctx: LlmStageContext, over: { stage?: string; invalidRetries?: 0 | 1 | 2 } = {}) =>
  c.generate(ctx, { stage: over.stage ?? "draft", schema, messages: msgs, maxOutputTokens: 500, ...(over.invalidRetries !== undefined && { invalidRetries: over.invalidRetries }) });
const cost = (m: ModelRow, i: number, o: number) => worstCaseMicroUsd(priceCardFor(m, [])!, { inputTokens: i, maxOutputTokens: o });

describe("LlmClient.generate refuses before reserving", () => {
  it("unpriced_model_is_refused_before_anything_is_reserved", async () => {
    const m = mk({ prices: null });
    const s = setup({ models: [m], script: [answer(good)] });
    const l = newLedger();
    await expect(gen(s.client, ctxOn(l))).rejects.toThrow(/no price/i);
    await expect(gen(s.client, ctxOn(l))).rejects.toBeInstanceOf(LlmRefusal);
    expect(l.reserves).toEqual([]);
    expect(s.seen).toEqual([]);
    expect(s.built).toEqual([]);
  });

  it("a_price_of_zero_on_a_hosted_model_is_unpriced", async () => {
    const s = setup({ models: [mk({ prices: { inputPerMTokMicro: 0, outputPerMTokMicro: 0 } })], script: [answer(good)] });
    const l = newLedger();
    await expect(gen(s.client, ctxOn(l))).rejects.toBeInstanceOf(LlmRefusal);
    expect(l.reserves).toEqual([]);
  });

  it("no_route_is_a_plain_error_and_no_fallback_model_is_used", async () => {
    const other = mk({ id: "00000000-0000-4000-8000-000000000002", label: "Other" });
    const s = setup({ models: [mk(), other], routes: { outline: other.id }, script: [answer(good)] });
    const l = newLedger();
    await expect(gen(s.client, ctxOn(l), { stage: "draft" })).rejects.toThrow(/No model is chosen for Draft/);
    expect(l.reserves).toEqual([]);
    expect(s.built).toEqual([]);
    expect(s.seen).toEqual([]);
  });

  it("a_failing_model_never_triggers_another_model", async () => {
    const other = mk({ id: "00000000-0000-4000-8000-000000000002", label: "Other" });
    const s = setup({ models: [mk(), other], routes: { draft: mk().id }, script: [new Error("provider down")] });
    const l = newLedger();
    await expect(gen(s.client, ctxOn(l))).rejects.toThrow("provider down");
    expect(s.built).toEqual([mk().id]);
    expect(s.seen).toHaveLength(1);
  });

  it("disabled_model_is_refused", async () => {
    const s = setup({ models: [mk({ enabled: false })], script: [answer(good)] });
    const l = newLedger();
    await expect(gen(s.client, ctxOn(l))).rejects.toThrow(/disabled/i);
    expect(l.reserves).toEqual([]);
  });

  it("ineligible_model_for_stage_is_refused", async () => {
    const s = setup({ models: [mk({ capabilities: { ...caps, structuredOutput: false } })], script: [answer(good)] });
    const l = newLedger();
    await expect(gen(s.client, ctxOn(l))).rejects.toThrow(/structured output/i);
    expect(l.reserves).toEqual([]);
    expect(s.built).toEqual([]);
  });

  it("unknown_stage_is_refused", async () => {
    const s = setup({ script: [answer(good)] });
    await expect(gen(s.client, ctxOn(newLedger()), { stage: "nope" })).rejects.toBeInstanceOf(LlmRefusal);
  });

  it("a_model_that_cannot_be_built_is_a_plain_refusal_without_reserving", async () => {
    const models = [mk()];
    const client = createLlmClient({
      db: undefined as never,
      catalog: { route: async () => models[0], localServices: async () => [] },
      getKey: async () => null,
      buildModel: () => {
        throw new Error("That base URL cannot be used as a model endpoint.");
      },
      budgetScopes: () => ["day"],
      makeStep: () => async () => answer(good),
    });
    const l = newLedger();
    await expect(gen(client, ctxOn(l))).rejects.toThrow(/base URL/);
    expect(l.reserves).toEqual([]);
  });
});

describe("LlmClient.generate paid steps", () => {
  it("reserves_the_worst_case_on_the_stage_scopes_and_returns_value_and_cost", async () => {
    const s = setup({ script: [answer(good, 120, 30)] });
    const l = newLedger();
    const r = await gen(s.client, ctxOn(l));
    expect(r.value).toEqual({ title: "hello", n: 3 });
    expect(r.spentMicroUsd).toBe(cost(mk(), 120, 30));
    expect(l.spent).toBe(cost(mk(), 120, 30));
    expect(l.reserves).toEqual([
      { step: 0, reserveMicroUsd: cost(mk(), estimateInputTokens(msgs), 500), budgetScopes: ["video:scene_kit", "day", "month", "draft_run"] },
    ]);
    expect(l.reserves[0]!.reserveMicroUsd).toBeGreaterThan(r.spentMicroUsd);
  });

  it("answer_wrapped_in_a_code_fence_is_accepted", async () => {
    const s = setup({ script: [answer("```json\n" + good + "\n```")] });
    expect((await gen(s.client, ctxOn(newLedger()))).value.n).toBe(3);
  });

  it("invalid_json_retry_is_a_separate_reserved_paid_step", async () => {
    const s = setup({ script: [answer("not json", 100, 10), answer(good, 160, 20)] });
    const l = newLedger();
    const r = await gen(s.client, ctxOn(l));
    expect(r.value.title).toBe("hello");
    expect(l.reserves.map((x) => x.step)).toEqual([0, 1]); // own step, own call key, own reservation
    expect(s.seen.map((x) => x.key)).toEqual(["key:0", "key:1"]);
    expect(r.spentMicroUsd).toBe(cost(mk(), 100, 10) + cost(mk(), 160, 20));
    expect(l.spent).toBe(r.spentMicroUsd); // nothing hidden
    const retryMsgs = s.seen[1]!.messages;
    expect(retryMsgs.at(-2)).toEqual({ role: "assistant", content: "not json", toolCalls: [] });
    expect(retryMsgs.at(-1)!.role).toBe("user");
    expect(retryMsgs.at(-1)!.content).toMatch(/not valid JSON/i);
    expect(l.reserves[1]!.reserveMicroUsd).toBeGreaterThan(l.reserves[0]!.reserveMicroUsd); // longer input, bigger worst case
  });

  it("schema_errors_are_fed_back_by_path_without_echoing_values", async () => {
    const s = setup({ script: [answer(JSON.stringify({ title: "", n: "SECRET-VALUE" })), answer(good)] });
    await gen(s.client, ctxOn(newLedger()));
    const feedback = s.seen[1]!.messages.at(-1)!.content;
    expect(feedback).toMatch(/title/);
    expect(feedback).toMatch(/n:/);
    expect(feedback).not.toContain("SECRET-VALUE");
  });

  it("model_chosen_key_names_and_values_are_never_echoed_in_feedback", async () => {
    const s = setup({ script: [answer(JSON.stringify({ title: "x", n: 1, "IGNORE-PREVIOUS-RULES": "y" })), answer(good)] });
    await gen(s.client, ctxOn(newLedger()));
    const feedback = s.seen[1]!.messages.at(-1)!.content;
    expect(feedback).not.toContain("IGNORE-PREVIOUS-RULES");
    expect(feedback).toMatch(/not allowed/i);
  });

  it("retry_cap_two_then_known_failure_with_spend_counted", async () => {
    const s = setup({ script: [answer("ZZQ1", 10, 1), answer("ZZQ2", 20, 1), answer("ZZQ3", 30, 1), answer(good)] });
    const l = newLedger();
    const err = await gen(s.client, ctxOn(l)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(KnownFailure);
    expect((err as Error).message).toMatch(/after 3 tries/);
    expect(l.reserves).toHaveLength(3);
    expect(s.seen).toHaveLength(3); // the fourth scripted answer is never asked for
    expect(l.spent).toBe(cost(mk(), 10, 1) + cost(mk(), 20, 1) + cost(mk(), 30, 1));
    expect((err as Error).message).not.toContain("ZZQ");
  });

  it("invalid_retries_zero_means_one_try_and_one_means_two", async () => {
    const s0 = setup({ script: [answer("x"), answer(good)] });
    await expect(gen(s0.client, ctxOn(newLedger()), { invalidRetries: 0 })).rejects.toBeInstanceOf(KnownFailure);
    expect(s0.seen).toHaveLength(1);
    const s1 = setup({ script: [answer("x"), answer("y"), answer(good)] });
    await expect(gen(s1.client, ctxOn(newLedger()), { invalidRetries: 1 })).rejects.toBeInstanceOf(KnownFailure);
    expect(s1.seen).toHaveLength(2);
  });

  it("invalid_retries_above_two_is_clamped", async () => {
    const s = setup({ script: [answer("1"), answer("2"), answer("3"), answer("4"), answer(good)] });
    await expect(gen(s.client, ctxOn(newLedger()), { invalidRetries: 9 as never })).rejects.toBeInstanceOf(KnownFailure);
    expect(s.seen).toHaveLength(3);
  });

  it("a_provider_error_is_not_retried_by_the_client", async () => {
    const s = setup({ script: [new Error("The provider answered with an error (503)."), answer(good)] });
    await expect(gen(s.client, ctxOn(newLedger()))).rejects.toThrow(/503/);
    expect(s.seen).toHaveLength(1);
  });

  it("giant_or_hostile_output_is_just_invalid", async () => {
    const s = setup({ script: [answer("x".repeat(2_000_000)), answer("\u0000{"), answer(good)] });
    const r = await gen(s.client, ctxOn(newLedger()));
    expect(r.value.n).toBe(3);
    expect(s.seen[2]!.messages.map((m) => m.content).join("").length).toBeLessThan(100_000); // the bad answer is cut in the feedback
  });

  it("generate_resumes_after_crash_with_zero_provider_calls_when_done", async () => {
    const s = setup({ script: [answer("bad", 100, 5), answer(good, 150, 9)] });
    const l = newLedger();
    const first = await gen(s.client, ctxOn(l));
    const callsAfterFirst = s.seen.length;
    const again = await gen(s.client, ctxOn(l)); // "new process": same ledger, step counter back at 0
    expect(s.seen.length).toBe(callsAfterFirst); // zero provider calls
    expect(again).toEqual(first);
    expect(l.spent).toBe(first.spentMicroUsd);
  });

  it("crash_between_two_tries_replays_the_first_and_repeats_only_the_second_with_identical_messages", async () => {
    const s = setup({ script: [answer("bad", 100, 5), new Error("worker died"), answer(good)] });
    const l = newLedger();
    await expect(gen(s.client, ctxOn(l))).rejects.toThrow("worker died");
    const r = await gen(s.client, ctxOn(l));
    expect(r.value.n).toBe(3);
    expect(s.seen).toHaveLength(3); // try 0 was NOT asked again
    expect(s.seen[2]!.messages).toEqual(s.seen[1]!.messages);
    expect(s.seen[2]!.key).toBe(s.seen[1]!.key);
  });

  it("local_free_model_reserves_zero_and_costs_zero", async () => {
    const m = mk({ provider: "ollama", baseUrl: "http://localhost:11434/v1", prices: null, isFree: true, endpointKind: "local" });
    const s = setup({ models: [m], script: [answer(good, 500, 200)], local: ["localhost:11434"] });
    const l = newLedger();
    const r = await gen(s.client, ctxOn(l));
    expect(r.spentMicroUsd).toBe(0);
    expect(l.reserves[0]!.reserveMicroUsd).toBe(0);
  });

  it("an_aborted_stage_does_not_start_a_try", async () => {
    const s = setup({ script: [answer(good)] });
    const ac = new AbortController();
    ac.abort();
    const ctx = { ...ctxOn(newLedger()), signal: ac.signal };
    await expect(gen(s.client, ctx)).rejects.toThrow();
    expect(s.seen).toEqual([]);
  });
});

describe("LlmClient.agent", () => {
  const tools = [{ name: "echo", description: "echo", inputSchema: { type: "object" }, run: async () => "ok" }];
  const run = (c: ReturnType<typeof setup>["client"], ctx: LlmStageContext) => c.agent(ctx, { stage: "draft", tools, messages: msgs, maxSteps: 3, maxOutputTokens: 200 });

  it("model_without_tool_use_is_refused_before_reserving", async () => {
    const s = setup({ models: [mk({ capabilities: { ...caps, toolUse: false } })], script: [answer("hi")] });
    const l = newLedger();
    await expect(run(s.client, ctxOn(l))).rejects.toThrow(/tool use/i);
    expect(l.reserves).toEqual([]);
  });

  it("a_tool_free_agent_call_needs_no_tool_use_so_scene_build_runs_on_a_text_only_model", async () => {
    const s = setup({ models: [mk({ capabilities: { ...caps, toolUse: false } })], routes: { build_scene_kit: mk().id }, script: [answer("scene")] });
    const out = await s.client.agent(ctxOn(newLedger()), { stage: "build_scene_kit", tools: [], messages: msgs, maxSteps: 1, maxOutputTokens: 200 });
    expect(out.text).toBe("scene");
  });

  it("agent_steps_go_through_the_stage_paid_function_and_share_its_step_numbers", async () => {
    const s = setup({ script: [answer(good, 50, 5), { text: "", toolCalls: [{ id: "c1", name: "echo", args: {} }], usage: { inputTokens: 40, outputTokens: 4 } }, answer("done", 60, 6)] });
    const l = newLedger();
    const ctx = ctxOn(l);
    await gen(s.client, ctx); // step 0
    const r = await run(s.client, ctx); // steps 1 and 2
    expect(l.reserves.map((x) => x.step)).toEqual([0, 1, 2]);
    expect(r.text).toBe("done");
    expect(r.spentMicroUsd).toBe(cost(mk(), 40, 4) + cost(mk(), 60, 6));
  });
});
