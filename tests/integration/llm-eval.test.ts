import type { LanguageModel } from "ai";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Message, ModelStep, StepResult } from "@/server/core/agent-loop";
import { wordRange } from "@/server/core/lang";
import { createModel, listRoutes, setRoute } from "@/server/db/llm-models";
import { applyDraftMode, EvalRefusal, fixedTopics, getEvalBadges, openEvalStage, planEval, runEval, type EvalDeps, type EvalRequest } from "@/server/db/llm-eval";
import { createWebTools } from "@/server/llm/web-tools";
import { reconcile } from "@/server/db/reconciler";
import { withTestDb, type TestDb } from "../support/db";

let db: TestDb;
beforeAll(async () => {
  db = await withTestDb();
});
afterAll(async () => {
  await db?.stop();
});

const caps = { structuredOutput: true, toolUse: true, vision: false, nativeWebSearch: false, contextWindow: 128000 };
const paid = { provider: "anthropic", modelId: "m-1", label: "Paid one", baseUrl: null, prices: { inputPerMTokMicro: 3_000_000, outputPerMTokMicro: 15_000_000 }, isFree: false, capabilities: caps, enabled: true };
const session = { actor: "session" } as const;
const owner = { kind: "owner_cli" };

const PAGE_URL = "https://a.test/octopus";
const PAGE = "The octopus has three hearts. Two pump blood to the gills while one serves the body. Octopus blood is blue.";
const QUOTE = "two pump blood to the gills while one serves the body";
const TOPICS = fixedTopics();

let modelId: string;
beforeEach(async () => {
  await db.reset();
  await db.pool.query("insert into budgets (scope, cap_micro_usd) values ('eval', 2000000), ('day', 15000000), ('month', 100000000)");
  const m = await createModel(db.pool, paid, session);
  modelId = m.id;
});

const words = (n: number) => Array.from({ length: n }, () => "word").join(" ");
function goodScript(quote = QUOTE, computedOnly = false) {
  const r = wordRange("en");
  const narration = words(Math.round((r.min + r.max) / 2));
  return {
    title: "Three hearts",
    description: "d",
    narration,
    beats: [{ id: "hook", text: narration }],
    evidence: computedOnly ? [{ text: "Three hearts times two", kind: "computed", method: "3 x 2 = 6" }] : [{ text: "Two hearts feed the gills", kind: "sourced", source_url: PAGE_URL, quote }],
  };
}
const ans = (o: unknown, outputTokens = 100): StepResult => ({ text: JSON.stringify(o), toolCalls: [], usage: { inputTokens: 200, outputTokens } });
const call = (name: string, args: unknown, id: string): StepResult => ({ text: "", toolCalls: [{ id, name, args }], usage: { inputTokens: 150, outputTokens: 20 } });

interface Fake {
  deps: EvalDeps;
  stats: { model: number };
}
/** A model scripted per topic: topics whose index is in `failing` never produce evidence that is on the fetched page. */
function fake(failing: number[] = [], opts: { outputTokens?: number; boom?: boolean; computedOnly?: boolean; onCall?: (n: number) => void } = {}): Fake {
  const stats = { model: 0 };
  const bad = new Set(failing.map((i) => TOPICS[i]!.topic));
  const fetchImpl = (async (url: string) => {
    if (url.includes("/search")) return new Response(JSON.stringify({ results: [{ title: "T", url: PAGE_URL, content: "c" }] }), { status: 200 });
    return new Response(`<p>${PAGE}</p>`, { status: 200 });
  }) as never;
  const step = (messages: Message[]): StepResult => {
    stats.model++;
    opts.onCall?.(stats.model);
    if (opts.boom) throw new Error("socket hang up");
    const text = messages.map((m) => m.content).join("\n");
    const isBad = [...bad].some((t) => text.includes(t));
    if (text.includes("plan web searches")) return ans({ queries: ["octopus hearts"] });
    const answer = ans(goodScript(isBad ? "this sentence was never said anywhere on the page" : QUOTE, opts.computedOnly), opts.outputTokens);
    const tools = messages.filter((m) => m.role === "tool").length;
    if (text.includes("webSearch") || text.includes("fetchPage")) {
      // agent prompt path (tools declared): search, fetch, then answer
      if (tools === 0) return call("webSearch", { query: "octopus hearts" }, "c1");
      if (tools === 1) return call("fetchPage", { url: PAGE_URL }, "c2");
    }
    return answer;
  };
  return {
    stats,
    deps: {
      getKey: async () => null,
      buildModel: () => ({}) as LanguageModel,
      makeWeb: () => createWebTools({ searxUrl: "http://127.0.0.1:8888", fetchImpl }),
      makeStep: (_m, decls): ModelStep => async (messages) => {
        // tell the prompt path apart by whether tools are declared for this run
        const withTools = decls.length > 0;
        const tagged = withTools ? [...messages, { role: "user", content: "webSearch fetchPage" } as Message] : messages;
        return step(tagged);
      },
    },
  };
}

const req = (over: Partial<EvalRequest> = {}): EvalRequest => ({ modelId, mode: "search_then_write", confirmed: true, actor: owner, ...over });
const mode = async () => (await db.pool.query("select draft_mode from llm_models where id = $1", [modelId])).rows[0].draft_mode as string;
const runs = async () => (await db.pool.query("select * from llm_eval_runs order by started_at, id")).rows;
const count = async (t: string) => (await db.pool.query(`select count(*)::int n from ${t}`)).rows[0].n as number;

describe("eval harness: mode decision", () => {
  it("agent_mode_needs_8_of_10_valid", async () => {
    const f = fake([8, 9]); // 2 of 10 fail -> 8 valid
    const out = await runEval(db.pool, req({ mode: "agent" }), f.deps);
    expect(out).toMatchObject({ topics: 10, valid: 10, evidenceValid: 8, stopped: "none", draftMode: "agent", draftModeChanged: true });
    expect(await mode()).toBe("agent");
    const audit = await db.pool.query("select detail from audit_log where event = 'model.changed'");
    expect(audit.rows.map((r) => r.detail)).toContainEqual(expect.objectContaining({ id: modelId, draftMode: "agent", from: "search_then_write", source: "eval" }));

    await db.ownerPool.query("truncate llm_eval_runs");
    await db.pool.query("update llm_models set draft_mode = 'search_then_write'");
    const seven = await runEval(db.pool, req({ mode: "agent" }), fake([7, 8, 9]).deps); // 3 fail -> 7 valid
    expect(seven).toMatchObject({ evidenceValid: 7, draftMode: "search_then_write", draftModeChanged: false });
    expect(await mode()).toBe("search_then_write");
  }, 120_000);

  it("a_model_never_evaluated_stays_search_then_write", async () => {
    expect(await mode()).toBe("search_then_write");
    expect((await getEvalBadges(db.pool)).size).toBe(0);
    // a perfect search-then-write run proves nothing about agent mode
    const out = await runEval(db.pool, req({ mode: "search_then_write" }), fake().deps);
    expect(out).toMatchObject({ valid: 10, draftMode: "search_then_write", draftModeChanged: false });
    expect(await mode()).toBe("search_then_write");
    expect((await getEvalBadges(db.pool)).get(modelId)).toMatchObject({ mode: "search_then_write", label: "search-then-write" });
  }, 120_000);

  it("a_short_run_cannot_turn_agent_mode_on", async () => {
    const out = await runEval(db.pool, req({ mode: "agent", topics: 3 }), fake().deps);
    expect(out).toMatchObject({ topics: 3, valid: 3 });
    expect(await mode()).toBe("search_then_write");
  }, 60_000);

  it("badge_shows_the_latest_run_and_never_a_stale_better_one", async () => {
    await runEval(db.pool, req({ mode: "agent" }), { ...fake().deps, now: () => new Date("2026-10-01T00:00:00Z") });
    expect(await mode()).toBe("agent");
    expect((await getEvalBadges(db.pool)).get(modelId)).toMatchObject({ mode: "agent", label: "agent mode proven 10/10" });
    await runEval(db.pool, req({ mode: "agent" }), { ...fake([0, 1, 2, 3, 4, 5]).deps, now: () => new Date("2026-10-02T00:00:00Z") }); // 4 of 10
    expect(await mode()).toBe("search_then_write"); // the newer, worse run wins
    expect((await getEvalBadges(db.pool)).get(modelId)).toMatchObject({ mode: "search_then_write", label: "search-then-write", detail: "agent run 4/10" });
  }, 180_000);
});

describe("eval harness: money", () => {
  it("eval_stops_at_its_cap_and_records_a_partial_run", async () => {
    // ~0.046 USD per call (3000 output tokens); two calls fit in 0.12, the third reservation does not.
    const f = fake([], { outputTokens: 3000 });
    const out = await runEval(db.pool, req({ maxUsd: 0.1 }), f.deps);
    expect(out.stopped).toBe("cap");
    expect(out.topics).toBe(1);
    expect(f.stats.model).toBe(3); // topic 1 (2 calls) + topic 2's cheap query call; nothing was sent after the refusal of its write
    const rows = await runs();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ topics: 1, mode_tested: "search_then_write" });
    expect(Number(rows[0].cost_micro_usd)).toBe(out.costMicroUsd);
    expect(Number(rows[0].cost_micro_usd)).toBeLessThanOrEqual(100_000);
    expect(rows[0].note).toMatch(/Stopped at the spend cap/);
    expect(await mode()).toBe("search_then_write");
  }, 60_000);

  it("the_lower_of_the_budget_cap_and_max_usd_wins", async () => {
    await runEval(db.pool, req({ topics: 1, maxUsd: 50 }), fake().deps);
    const cap = await db.pool.query("select scope, cap_micro_usd from budgets where scope like 'eval_run:%'");
    expect(cap.rows).toHaveLength(1);
    expect(Number(cap.rows[0].cap_micro_usd)).toBe(2_000_000); // the seeded eval cap is lower than 50 USD
    await runEval(db.pool, req({ topics: 1, maxUsd: 0.5 }), fake().deps);
    const caps2 = await db.pool.query("select cap_micro_usd from budgets where scope like 'eval_run:%' order by cap_micro_usd");
    expect(caps2.rows.map((r) => Number(r.cap_micro_usd))).toEqual([500_000, 2_000_000]);
  }, 60_000);

  it("eval_spend_goes_through_reservation_and_shows_in_the_ledger", async () => {
    const f = fake();
    const out = await runEval(db.pool, req({ topics: 2 }), f.deps);
    const intents = await db.pool.query("select status, actual_micro_usd, reserved_micro_usd from spend_intents");
    expect(intents.rows).toHaveLength(f.stats.model);
    expect(intents.rows.every((r) => r.status === "done" && Number(r.reserved_micro_usd) > 0)).toBe(true);
    const ledger = intents.rows.reduce((a, r) => a + Number(r.actual_micro_usd), 0);
    expect(ledger).toBeGreaterThan(0);
    expect(out.costMicroUsd).toBe(ledger);
    const b = await db.pool.query("select scope, reserved_micro_usd r, spent_micro_usd s from budgets where scope like 'eval_run:%' or scope like 'day:%' or scope like 'month:%'");
    expect(b.rows).toHaveLength(3);
    for (const r of b.rows) expect([Number(r.r), Number(r.s)]).toEqual([0, ledger]);
    // the template row was never charged directly
    expect((await db.pool.query("select spent_micro_usd s from budgets where scope = 'eval'")).rows[0].s).toBe("0");
    // each topic is its own synthetic stage
    expect((await db.pool.query("select count(*)::int n from stage_runs where name = 'llm_eval' and status = 'succeeded'")).rows[0].n).toBe(2);
  }, 60_000);

  it("an_unclear_call_stops_the_eval_is_never_retried_and_keeps_the_reservation", async () => {
    const f = fake([], { boom: true });
    const out = await runEval(db.pool, req(), f.deps);
    expect(out.stopped).toBe("unclear");
    expect(f.stats.model).toBe(1);
    expect(out.topics).toBe(0);
    const intent = await db.pool.query("select status from spend_intents");
    expect(intent.rows).toHaveLength(1);
    expect(["pending", "unknown"]).toContain(intent.rows[0].status); // never settled, never released
    const b = await db.pool.query("select reserved_micro_usd r from budgets where scope like 'eval_run:%'");
    expect(Number(b.rows[0].r)).toBeGreaterThan(0);
    expect((await db.pool.query("select status from stage_runs where name = 'llm_eval'")).rows[0].status).toBe("needs_decision");
    expect((await runs())[0].note).toMatch(/may have been charged/);
  }, 60_000);

  it("the_eval_changes_only_draft_mode_never_routes_or_prices", async () => {
    await setRoute(db.pool, "draft", modelId, session);
    const before = await listRoutes(db.pool);
    const priceBefore = (await db.pool.query("select prices, enabled from llm_models where id = $1", [modelId])).rows[0];
    await runEval(db.pool, req({ mode: "agent", topics: 2 }), fake().deps);
    expect(await listRoutes(db.pool)).toEqual(before);
    expect((await db.pool.query("select prices, enabled from llm_models where id = $1", [modelId])).rows[0]).toEqual(priceBefore);
  }, 60_000);
});

describe("eval harness: review fixes", () => {
  it("applyDraftMode_locks_the_model_row_before_it_reads_the_runs", async () => {
    // A concurrent eval has locked the model and is about to commit an agent run. The decision must wait for it and include it.
    const a = await db.pool.connect();
    try {
      await a.query("begin");
      await a.query("select 1 from llm_models where id = $1 for update", [modelId]);
      const b = await db.pool.connect();
      let settled = false;
      const decision = (async () => {
        await b.query("begin");
        const r = await applyDraftMode(b, modelId, "owner");
        await b.query("commit");
        settled = true;
        return r;
      })().finally(() => b.release());
      await new Promise((r) => setTimeout(r, 300));
      expect(settled).toBe(false); // blocked on the lock, not reading a stale (empty) run list
      await a.query(
        "insert into llm_eval_runs (id, model_id, topics, valid, evidence_valid, cost_micro_usd, p50_latency_ms, mode_tested) values (gen_random_uuid(), $1, 10, 10, 10, 0, 0, 'agent')",
        [modelId],
      );
      await a.query("commit");
      expect(await decision).toEqual({ mode: "agent", changed: true });
    } finally {
      a.release();
    }
    expect(await mode()).toBe("agent");
  });

  it("an_all_computed_script_does_not_count_as_valid_evidence", async () => {
    const out = await runEval(db.pool, req({ mode: "agent" }), fake([], { computedOnly: true }).deps);
    expect(out).toMatchObject({ topics: 10, valid: 10, evidenceValid: 0, draftMode: "search_then_write" });
    expect(await mode()).toBe("search_then_write");
  }, 120_000);

  it("an_abort_stops_new_topics_ends_the_stage_and_records_the_partial_run", async () => {
    const stop = new AbortController();
    const f = fake([], { onCall: (n) => n === 3 && stop.abort() }); // topic 1 = 2 calls; abort during topic 2's first call
    const out = await runEval(db.pool, req(), { ...f.deps, signal: stop.signal });
    expect(out.stopped).toBe("aborted");
    expect(out.topics).toBe(1);
    expect(f.stats.model).toBe(3); // nothing sent after the abort
    const rows = await runs();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ topics: 1 });
    expect(rows[0].note).toMatch(/Stopped by the owner/);
    const st = await db.pool.query("select status from stage_runs where name = 'llm_eval' order by id");
    expect(st.rows.map((r) => r.status)).toEqual(["succeeded", "needs_decision"]); // none left running
    expect(await mode()).toBe("search_then_write");
  }, 60_000);

  it("an_already_aborted_run_sends_nothing_and_still_records_a_row", async () => {
    const stop = new AbortController();
    stop.abort();
    const f = fake();
    const out = await runEval(db.pool, req(), { ...f.deps, signal: stop.signal });
    expect(out).toMatchObject({ stopped: "aborted", topics: 0 });
    expect(f.stats.model).toBe(0);
    expect(await count("stage_runs")).toBe(0);
    expect(await count("llm_eval_runs")).toBe(1);
  });

  const idle = { enqueue: async () => undefined, liveJobIds: async () => new Set<string>() };

  it("reconciler_ends_an_expired_llm_eval_stage_and_never_requeues_it", async () => {
    const claim = await openEvalStage(db.pool, "r1", 0); // process died: running, no intent
    await db.ownerPool.query("update stage_runs set lease_until = clock_timestamp() - interval '1 second' where id = $1", [claim.stageRunId]);
    const enqueued: string[] = [];
    const out = await reconcile(db.pool, { ...idle, enqueue: async (id: string) => void enqueued.push(id) } as never, { graceMs: 0 });
    expect(enqueued).toEqual([]);
    expect(out.requeued).toEqual([]);
    expect((await db.pool.query("select status from stage_runs where id = $1", [claim.stageRunId])).rows[0].status).toBe("failed");
  });

  it("reconciler_never_enqueues_a_queued_llm_eval_row", async () => {
    const claim = await openEvalStage(db.pool, "r2", 0);
    await db.ownerPool.query("update stage_runs set status = 'queued', lease_owner = null, lease_until = null, updated_at = now() - interval '1 hour' where id = $1", [claim.stageRunId]);
    const enqueued: string[] = [];
    await reconcile(db.pool, { ...idle, enqueue: async (id: string) => void enqueued.push(id) } as never, { graceMs: 0 });
    expect(enqueued).toEqual([]);
  });
});

describe("eval harness: refusals", () => {
  it("eval_refuses_without_yes_and_without_a_model_id", async () => {
    const f = fake();
    await expect(runEval(db.pool, req({ confirmed: false }), f.deps)).rejects.toThrow(/^This eval can spend up to 2.00 USD on Paid one\. Confirm it to run\.$/);
    await expect(runEval(db.pool, req({ modelId: "" }), f.deps)).rejects.toBeInstanceOf(EvalRefusal);
    await expect(runEval(db.pool, req({ modelId: "not-a-uuid" }), f.deps)).rejects.toBeInstanceOf(EvalRefusal);
    await expect(runEval(db.pool, req({ modelId: "00000000-0000-4000-8000-000000000000" }), f.deps)).rejects.toThrow(/Unknown model/);
    expect(f.stats.model).toBe(0);
    expect(await count("stage_runs")).toBe(0);
    expect(await count("spend_intents")).toBe(0);
    expect(await count("llm_eval_runs")).toBe(0);
    expect((await db.pool.query("select 1 from budgets where scope like 'eval_run:%'")).rowCount).toBe(0);
  });

  it("only_the_owner_can_run_an_eval", async () => {
    const f = fake();
    for (const kind of ["token", "job", "system", ""]) {
      await expect(runEval(db.pool, req({ actor: { kind } }), f.deps)).rejects.toThrow(/Only the owner/);
    }
    await expect(runEval(db.pool, req({ actor: undefined as never }), f.deps)).rejects.toThrow(/Only the owner/);
    expect(f.stats.model).toBe(0);
    expect(await count("stage_runs")).toBe(0);
    // a signed-in session may
    await expect(planEval(db.pool, { modelId, mode: "search_then_write", actor: { kind: "session" } }, {})).resolves.toMatchObject({ ceilingMicroUsd: 2_000_000 });
  });

  it("an_unpriced_model_a_bad_cap_and_bad_topic_counts_are_refused_before_anything_is_written", async () => {
    const f = fake();
    const free = await createModel(db.pool, { ...paid, modelId: "m-2", label: "No price" }, session);
    await db.ownerPool.query("update llm_models set prices = null, enabled = false where id = $1", [free.id]);
    await expect(runEval(db.pool, req({ modelId: free.id }), f.deps)).rejects.toBeInstanceOf(EvalRefusal);
    for (const maxUsd of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(runEval(db.pool, req({ maxUsd }), f.deps)).rejects.toBeInstanceOf(EvalRefusal);
    }
    for (const topics of [0, 11, 2.5, -1]) {
      await expect(runEval(db.pool, req({ topics }), f.deps)).rejects.toBeInstanceOf(EvalRefusal);
    }
    await db.pool.query("update llm_models set capabilities = jsonb_set(capabilities, '{toolUse}', 'false') where id = $1", [modelId]);
    await expect(runEval(db.pool, req({ mode: "agent" }), f.deps)).rejects.toThrow(/tool use/);
    expect(f.stats.model).toBe(0);
    expect(await count("stage_runs")).toBe(0);
    expect(await count("llm_eval_runs")).toBe(0);
  });

  it("a_missing_eval_budget_refuses_instead_of_spending_uncapped", async () => {
    await db.ownerPool.query("delete from budgets where scope = 'eval'");
    const f = fake();
    await expect(runEval(db.pool, req(), f.deps)).rejects.toThrow(/budget is not set up/);
    expect(f.stats.model).toBe(0);
  });
});

describe("eval harness: records", () => {
  it("eval_results_are_append_only", async () => {
    await runEval(db.pool, req({ topics: 1 }), fake().deps);
    expect(await count("llm_eval_runs")).toBe(1);
    await expect(db.pool.query("update llm_eval_runs set valid = 10")).rejects.toThrow(/permission denied/);
    await expect(db.pool.query("delete from llm_eval_runs")).rejects.toThrow(/permission denied/);
    await expect(db.pool.query("truncate llm_eval_runs")).rejects.toThrow(/permission denied/);
    expect(await count("llm_eval_runs")).toBe(1);
  }, 60_000);

  it("counts_are_constrained_by_the_database", async () => {
    const bad = (vals: string) => db.pool.query(`insert into llm_eval_runs (id, model_id, topics, valid, evidence_valid, cost_micro_usd, p50_latency_ms, mode_tested) values (gen_random_uuid(), gen_random_uuid(), ${vals})`);
    await expect(bad("5, 6, 6, 0, 0, 'agent'")).rejects.toThrow();
    await expect(bad("5, 4, 5, 0, 0, 'agent'")).rejects.toThrow();
    await expect(bad("5, 4, 4, -1, 0, 'agent'")).rejects.toThrow();
    await expect(bad("5, 4, 4, 0, 0, 'magic'")).rejects.toThrow();
  });
});
