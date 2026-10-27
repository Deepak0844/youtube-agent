import { APICallError } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { CatalogError, createModel } from "@/server/db/llm-models";
import { getLastTests, openTestStage, testModel, type TestDeps } from "@/server/db/llm-test";
import { reconcile } from "@/server/db/reconciler";
import { withTestDb, type TestDb } from "../support/db";

let db: TestDb;
const KEY = "sk-ant-api03-LEAKCANARY0123456789abcdefghijklmnop";
const NIL = "00000000-0000-0000-0000-000000000000";
const session = { kind: "session" } as const;
const caps = { structuredOutput: true, toolUse: true, vision: false, nativeWebSearch: false, contextWindow: 128000 };
const hosted = (label: string, over: Record<string, unknown> = {}) => ({
  provider: "anthropic",
  modelId: `m-${label}`,
  label,
  baseUrl: null,
  prices: { inputPerMTokMicro: 3_000_000, outputPerMTokMicro: 15_000_000 },
  isFree: false,
  capabilities: caps,
  enabled: true,
  ...over,
});
const local = {
  provider: "ollama",
  modelId: "q-7b",
  label: "Local seven",
  baseUrl: "http://localhost:11434/v1",
  prices: null,
  isFree: true,
  capabilities: caps,
  enabled: true,
};

beforeAll(async () => {
  db = await withTestDb();
});
afterAll(async () => {
  await db?.stop();
});
beforeEach(async () => {
  await db.reset();
  await db.ownerPool.query(await readFile("src/server/db/migrations/0005_settings.sql", "utf8")); // default settings
  await db.ownerPool.query(await readFile("src/server/db/migrations/0018_llm_test_eval.sql", "utf8")); // test + eval budgets
  await db.ownerPool.query("update settings set value = '[\"localhost:11434\"]'::jsonb where key = 'network.local_services'");
});

const usage = (i: number, o: number) => ({
  inputTokens: { total: i, noCache: i, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: o, text: o, reasoning: undefined },
});
const reply = (text: string, i = 40, o = 6) => ({ content: [{ type: "text", text }], finishReason: { unified: "stop", raw: "stop" }, usage: usage(i, o), warnings: [] }) as never;

function depsFor(model: MockLanguageModelV4, over: Partial<TestDeps> = {}): TestDeps {
  return { getKey: async () => KEY, buildModel: () => model, cooldownMs: 0, ...over };
}
const okModel = () => new MockLanguageModelV4({ doGenerate: reply('{"ok":true}') });
const add = async (raw: Record<string, unknown>) => (await createModel(db.pool, raw, { actor: "session" })).id;
const one = async <T = Record<string, unknown>>(sql: string, args: unknown[] = []) => (await db.ownerPool.query(sql, args)).rows[0] as T;
const budget = async (scope: string) => one<{ cap: string; reserved: string; spent: string }>("select cap_micro_usd cap, reserved_micro_usd reserved, spent_micro_usd spent from budgets where scope = $1", [scope]);
const todayScope = async () => (await one<{ s: string }>("select 'llm_test:' || to_char(clock_timestamp() at time zone 'utc', 'YYYY-MM-DD') s")).s;
const dump = async () =>
  JSON.stringify([
    (await db.ownerPool.query("select * from audit_log")).rows,
    (await db.ownerPool.query("select * from spend_intents")).rows,
    (await db.ownerPool.query("select * from stage_runs")).rows,
    (await db.ownerPool.query("select id, last_test from llm_models")).rows,
  ]);

describe("migration 0018", () => {
  it("seeds_the_two_budgets_and_the_model_columns_with_safe_defaults", async () => {
    expect(Number((await budget("llm_test")).cap)).toBe(500_000);
    expect(Number((await budget("eval")).cap)).toBe(2_000_000);
    const id = await add(hosted("A"));
    const row = await one<{ draft_mode: string; last_test: unknown }>("select draft_mode, last_test from llm_models where id = $1", [id]);
    expect(row).toEqual({ draft_mode: "search_then_write", last_test: null });
    await expect(db.ownerPool.query("update llm_models set draft_mode = 'whatever' where id = $1", [id])).rejects.toThrow();
  });

  it("is_safe_to_run_twice_and_never_resets_a_changed_cap", async () => {
    await db.ownerPool.query("update budgets set cap_micro_usd = 123 where scope = 'llm_test'");
    await db.ownerPool.query(await readFile("src/server/db/migrations/0018_llm_test_eval.sql", "utf8"));
    expect(Number((await budget("llm_test")).cap)).toBe(123);
  });
});

describe("hosted Test button", () => {
  it("test_button_costs_are_reserved_settled_and_capped", async () => {
    const id = await add(hosted("A"));
    let duringCall: { reserved: string; spent: string } | undefined;
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        duringCall = await budget(await todayScope());
        return reply('{"ok":true}', 40, 6);
      },
    });
    const r = await testModel(db.pool, id, session, depsFor(model));
    expect(r).toMatchObject({ ok: true, structuredOutput: true });
    // reserved while the call ran, on today's row only
    expect(Number(duringCall!.reserved)).toBeGreaterThan(0);
    expect(Number(duringCall!.spent)).toBe(0);
    // settled: reservation gone, the real (token-priced) cost is spent
    const day = await budget(await todayScope());
    expect(Number(day.reserved)).toBe(0);
    expect(Number(day.spent)).toBe(r.costMicroUsd);
    expect(r.costMicroUsd).toBe(Math.ceil((40 * 3_000_000) / 1e6) + Math.ceil((6 * 15_000_000) / 1e6));
    expect(Number((await budget("llm_test")).spent)).toBe(0); // the template row is never spent
    expect(model.doGenerateCalls[0]!.maxOutputTokens).toBe(64);
    // exactly one call, one settled intent
    const intent = await one<{ status: string; scopes: string[]; actual_micro_usd: string }>("select status, scopes, actual_micro_usd from spend_intents");
    expect(intent).toMatchObject({ status: "done", scopes: [await todayScope()] });
    expect(Number(intent.actual_micro_usd)).toBe(r.costMicroUsd);
  });

  it("daily_cap_stops_the_next_test_without_calling_the_provider", async () => {
    await db.ownerPool.query("update budgets set cap_micro_usd = 1400 where scope = 'llm_test'"); // first reserves ~1260, spends 210; a second 1260 would pass 1400
    const id = await add(hosted("A"));
    const id2 = await add(hosted("B"));
    const first = await testModel(db.pool, id, session, depsFor(okModel()));
    expect(first.ok).toBe(true);
    const second = new MockLanguageModelV4({ doGenerate: reply('{"ok":true}') });
    const r = await testModel(db.pool, id2, session, depsFor(second));
    expect(r).toMatchObject({ ok: false, costMicroUsd: 0 });
    expect(r.message).toMatch(/budget/i);
    expect(second.doGenerateCalls).toHaveLength(0);
    const day = await budget(await todayScope());
    expect(Number(day.reserved)).toBe(0);
    expect(Number(day.spent)).toBe(first.costMicroUsd);
  });

  it("the_daily_row_is_copied_from_the_template_and_a_new_day_starts_empty", async () => {
    const id = await add(hosted("A"));
    await testModel(db.pool, id, session, depsFor(okModel()));
    const today = await budget(await todayScope());
    expect(Number(today.cap)).toBe(500_000);
    // yesterday's row (spent) does not affect today
    await db.ownerPool.query("insert into budgets (scope, cap_micro_usd, spent_micro_usd) values ('llm_test:2000-01-01', 500000, 500000)");
    const r = await testModel(db.pool, id, session, depsFor(okModel()));
    expect(r.ok).toBe(true);
  });

  it("without_a_template_row_nothing_is_spent", async () => {
    await db.ownerPool.query("delete from budgets where scope = 'llm_test'");
    const id = await add(hosted("A"));
    const model = okModel();
    await expect(testModel(db.pool, id, session, depsFor(model))).rejects.toBeInstanceOf(CatalogError);
    expect(model.doGenerateCalls).toHaveLength(0);
  });

  it("test_is_session_only", async () => {
    const id = await add(hosted("A"));
    const model = okModel();
    for (const kind of ["token", "system", "anon", "job", ""]) {
      await expect(testModel(db.pool, id, { kind } as never, depsFor(model))).rejects.toBeInstanceOf(CatalogError);
    }
    await expect(testModel(db.pool, id, undefined as never, depsFor(model))).rejects.toBeInstanceOf(CatalogError);
    expect(model.doGenerateCalls).toHaveLength(0);
    expect((await db.ownerPool.query("select 1 from stage_runs")).rowCount).toBe(0);
    expect((await db.ownerPool.query("select 1 from audit_log where event = 'model.tested'")).rowCount).toBe(0);
  });

  it("test_cooldown_per_model", async () => {
    const a = await add(hosted("A"));
    const b = await add(hosted("B"));
    const model = okModel();
    const d = depsFor(model, { cooldownMs: 30_000 });
    expect((await testModel(db.pool, a, session, d)).ok).toBe(true);
    await expect(testModel(db.pool, a, session, d)).rejects.toThrow(/shortly|moment/i);
    expect(model.doGenerateCalls).toHaveLength(1);
    expect((await testModel(db.pool, b, session, d)).ok).toBe(true); // another model is its own cooldown
    // 31 seconds later, by the database clock
    await db.ownerPool.query("update llm_models set last_test = jsonb_set(last_test, '{at}', to_jsonb(clock_timestamp() - interval '31 seconds')) where id = $1", [a]);
    expect((await testModel(db.pool, a, session, d)).ok).toBe(true);
  });

  it("twenty_concurrent_clicks_make_exactly_one_provider_call", async () => {
    const id = await add(hosted("A"));
    const model = okModel();
    const d = depsFor(model, { cooldownMs: 30_000 });
    const res = await Promise.allSettled(Array.from({ length: 20 }, () => testModel(db.pool, id, session, d)));
    expect(res.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    expect(model.doGenerateCalls).toHaveLength(1);
    expect((await db.ownerPool.query("select 1 from spend_intents")).rowCount).toBe(1);
  });

  it("a_failed_attempt_also_starts_the_cooldown", async () => {
    const id = await add(hosted("A"));
    const bad = new MockLanguageModelV4({ doGenerate: async () => Promise.reject(new APICallError({ message: "x", url: "https://a.b/c", requestBodyValues: {}, statusCode: 401 })) });
    const d = depsFor(bad, { cooldownMs: 30_000 });
    expect((await testModel(db.pool, id, session, d)).ok).toBe(false);
    await expect(testModel(db.pool, id, session, d)).rejects.toThrow(/shortly|moment/i);
  });

  it("test_result_never_contains_the_key_or_provider_body", async () => {
    const id = await add(hosted("A"));
    const leaky = new APICallError({
      message: `Incorrect API key provided: ${KEY}`,
      url: `https://api.example.com/v1/messages?key=${KEY}`,
      requestBodyValues: { authorization: `Bearer ${KEY}` },
      statusCode: 401,
      responseHeaders: { "x-echo": KEY },
      responseBody: JSON.stringify({ error: `bad key ${KEY}` }),
    });
    const r = await testModel(db.pool, id, session, depsFor(new MockLanguageModelV4({ doGenerate: async () => Promise.reject(leaky) })));
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/key/i);
    expect(JSON.stringify(r)).not.toContain("LEAKCANARY");
    expect(await dump()).not.toContain("LEAKCANARY");
    expect(await dump()).not.toContain("api.example.com");
    // an answer that echoes the key is not shown either
    await db.ownerPool.query("update llm_models set last_test = null");
    const echo = await testModel(db.pool, id, session, depsFor(new MockLanguageModelV4({ doGenerate: reply(`here is your key ${KEY}`) })));
    expect(echo).toMatchObject({ ok: true, structuredOutput: false });
    expect(JSON.stringify(echo)).not.toContain("LEAKCANARY");
    expect(await dump()).not.toContain("LEAKCANARY");
  });

  it("a_clear_provider_rejection_is_free_and_leaves_nothing_reserved", async () => {
    const id = await add(hosted("A"));
    const bad = new MockLanguageModelV4({ doGenerate: async () => Promise.reject(new APICallError({ message: "x", url: "https://a.b/c", requestBodyValues: {}, statusCode: 429 })) });
    const r = await testModel(db.pool, id, session, depsFor(bad));
    expect(r).toMatchObject({ ok: false, costMicroUsd: 0 });
    expect(r.message).toMatch(/429/);
    const day = await budget(await todayScope());
    expect([day.reserved, day.spent]).toEqual(["0", "0"]);
    expect((await one<{ status: string }>("select status from spend_intents")).status).toBe("failed_known");
    expect((await one<{ status: string }>("select status from stage_runs")).status).toBe("failed");
  });

  it("an_unclear_outcome_keeps_the_reservation_parks_the_stage_and_is_never_retried", async () => {
    const id = await add(hosted("A"));
    const boom = new MockLanguageModelV4({ doGenerate: async () => Promise.reject(new APICallError({ message: "x", url: "https://a.b/c", requestBodyValues: {}, statusCode: 503 })) });
    const r = await testModel(db.pool, id, session, depsFor(boom));
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/may have|charged|reserved/i);
    expect(boom.doGenerateCalls).toHaveLength(1); // the SDK's own retries are off
    const day = await budget(await todayScope());
    expect(Number(day.reserved)).toBeGreaterThan(0); // held until a human decides
    expect((await one<{ status: string }>("select status from spend_intents")).status).toBe("pending");
    expect((await one<{ status: string }>("select status from stage_runs")).status).toBe("needs_decision");
  });

  it("a_hung_call_is_stopped_at_the_timeout_and_treated_as_unclear", async () => {
    const id = await add(hosted("A"));
    const hang = new MockLanguageModelV4({
      doGenerate: (opts: { abortSignal?: AbortSignal }) =>
        new Promise((_, rej) => opts.abortSignal?.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" })))),
    });
    const r = await testModel(db.pool, id, session, depsFor(hang, { timeoutMs: 80 }));
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/may have|charged|reserved/i);
    expect((await one<{ status: string }>("select status from stage_runs")).status).toBe("needs_decision");
  });

  it("test_on_local_model_is_free_and_still_audited", async () => {
    const id = await add(local);
    const r = await testModel(db.pool, id, session, depsFor(okModel()));
    expect(r).toMatchObject({ ok: true, costMicroUsd: 0 });
    const intent = await one<{ status: string; reserved_micro_usd: string; actual_micro_usd: string }>("select status, reserved_micro_usd, actual_micro_usd from spend_intents");
    expect(intent).toMatchObject({ status: "done", reserved_micro_usd: "0", actual_micro_usd: "0" }); // same code path, price 0
    const audit = await one<{ detail: Record<string, unknown> }>("select detail from audit_log where event = 'model.tested'");
    expect(audit.detail).toMatchObject({ ok: true, free: true, costMicroUsd: 0 });
  });

  it("unpriced_model_is_refused_before_anything_is_reserved_or_written", async () => {
    const id = await add(hosted("A", { prices: null, enabled: false }));
    const model = okModel();
    await expect(testModel(db.pool, id, session, depsFor(model))).rejects.toThrow(/no price/i);
    expect(model.doGenerateCalls).toHaveLength(0);
    expect((await db.ownerPool.query("select 1 from spend_intents")).rowCount).toBe(0);
    expect((await db.ownerPool.query("select 1 from stage_runs")).rowCount).toBe(0);
    expect((await one<{ last_test: unknown }>("select last_test from llm_models")).last_test).toBeNull();
  });

  it("a_disabled_but_priced_model_can_be_tested_before_it_is_enabled", async () => {
    const id = await add(hosted("A", { enabled: false }));
    expect((await testModel(db.pool, id, session, depsFor(okModel()))).ok).toBe(true);
  });

  it("unknown_model_and_bad_ids_are_plain_refusals", async () => {
    for (const bad of ["nope", NIL, "00000000-0000-4000-8000-0000000000ff"]) {
      await expect(testModel(db.pool, bad, session, depsFor(okModel()))).rejects.toBeInstanceOf(CatalogError);
    }
  });

  it("a_missing_key_is_a_free_plain_failure", async () => {
    const id = await add(hosted("A"));
    // the real factory path would call getKey inside the request; here the step throws what the factory throws
    const noKey = new MockLanguageModelV4({ doGenerate: async () => Promise.reject(new Error("No key saved for Anthropic")) });
    const r = await testModel(db.pool, id, session, depsFor(noKey));
    expect(r).toMatchObject({ ok: false, costMicroUsd: 0, message: "No key saved for Anthropic. Nothing was charged." });
    const day = await budget(await todayScope());
    expect([day.reserved, day.spent]).toEqual(["0", "0"]);
  });

  it("writes_a_synthetic_stage_one_audit_row_and_the_last_result", async () => {
    const id = await add(hosted("A"));
    const r = await testModel(db.pool, id, session, depsFor(okModel()));
    const stage = await one<{ name: string; video_id: string; status: string; fence: string }>("select name, video_id, status, fence from stage_runs");
    expect(stage).toMatchObject({ name: "model_test", video_id: NIL, status: "succeeded", fence: "1" });
    const audits = (await db.ownerPool.query("select detail from audit_log where event = 'model.tested'")).rows;
    expect(audits).toHaveLength(1);
    expect(audits[0].detail).toMatchObject({ id, provider: "anthropic", ok: true, structured: true, costMicroUsd: r.costMicroUsd });
    const last = (await getLastTests(db.pool)).get(id)!;
    expect(last).toMatchObject({ ok: true, structuredOutput: true, costMicroUsd: r.costMicroUsd, latencyMs: r.latencyMs });
    expect(last.at).toBeInstanceOf(Date);
    expect(last.message).toBe(r.message);
  });

  it("models_without_a_test_have_no_entry_and_a_tampered_entry_reads_as_none", async () => {
    const id = await add(hosted("A"));
    expect((await getLastTests(db.pool)).size).toBe(0);
    await db.ownerPool.query("update llm_models set last_test = '{\"ok\":\"yes\",\"at\":5}'::jsonb where id = $1", [id]);
    expect((await getLastTests(db.pool)).size).toBe(0);
  });

  it("a_synthetic_test_stage_is_never_picked_up_by_the_reconciler_loops", async () => {
    const id = await add(hosted("A"));
    await testModel(db.pool, id, session, depsFor(okModel()));
    const s = await one<{ status: string }>("select status from stage_runs");
    expect(["succeeded", "failed", "needs_decision"]).toContain(s.status); // never left queued or running
  });

  const idle = { enqueue: async () => undefined, liveJobIds: async () => new Set<string>() };

  it("crash_between_opening_the_test_stage_and_reserving_never_gets_requeued", async () => {
    const claim = await openTestStage(db.pool); // process dies here: running, no intent
    await db.ownerPool.query("update stage_runs set lease_until = clock_timestamp() - interval '1 second' where id = $1", [claim.stageRunId]);
    const enqueued: string[] = [];
    const out = await reconcile(db.pool, { ...idle, enqueue: async (id: string) => void enqueued.push(id) } as never, { graceMs: 0 });
    expect(enqueued).toEqual([]);
    expect(out.requeued).toEqual([]);
    expect((await one<{ status: string }>("select status from stage_runs where id = $1", [claim.stageRunId])).status).toBe("failed");
  });

  it("a_queued_model_test_row_is_never_enqueued_by_the_reconciler", async () => {
    const claim = await openTestStage(db.pool);
    await db.ownerPool.query("update stage_runs set status = 'queued', lease_owner = null, lease_until = null, updated_at = now() - interval '1 hour' where id = $1", [claim.stageRunId]);
    const enqueued: string[] = [];
    await reconcile(db.pool, { ...idle, enqueue: async (id: string) => void enqueued.push(id) } as never, { graceMs: 0 });
    expect(enqueued).toEqual([]);
  });

  it("an_unconfirmed_release_is_not_reported_as_nothing_charged", async () => {
    const id = await add(hosted("A"));
    const bad = new MockLanguageModelV4({ doGenerate: async () => Promise.reject(new APICallError({ message: "x", url: "https://a.b/c", requestBodyValues: {}, statusCode: 401 })) });
    const wrapPorts: TestDeps["wrapPorts"] = (p) => ({ ...p, failKnown: async () => { throw new Error("db down"); }, warn: () => {} });
    const r = await testModel(db.pool, id, session, depsFor(bad, { wrapPorts }));
    expect(r.ok).toBe(false);
    expect(r.message).not.toMatch(/nothing was charged/i);
    expect(r.message).toMatch(/may have|reserved/i);
    expect((await one<{ status: string }>("select status from stage_runs")).status).toBe("needs_decision");
    expect((await one<{ status: string }>("select status from spend_intents")).status).toBe("pending");
  });

  it("a_last_test_without_a_usable_time_does_not_lock_the_model_out", async () => {
    const id = await add(hosted("A"));
    for (const bad of ['{"ok":true}', '{"ok":true,"at":"garbage"}', '{"ok":true,"at":5}', '{"at":null}']) {
      await db.ownerPool.query("update llm_models set last_test = $2::jsonb where id = $1", [id, bad]);
      expect((await testModel(db.pool, id, session, depsFor(okModel(), { cooldownMs: 30_000 }))).ok, bad).toBe(true);
    }
  });
});
