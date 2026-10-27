import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createPgAgentStepStore, pruneAgentSteps } from "@/server/db/agent-steps";
import { hashToolArgs, runAgent, TOOL_OUTPUT_MAX_BYTES, type ModelStep, type StepResult } from "@/server/core/agent-loop";
import { createPgPaidCallPorts } from "@/server/db/paid-call-adapter";
import { claimStage, insertQueuedStage, type Claim } from "@/server/db/stages";
import { uuidv7 } from "@/server/core/ids";
import { withTestDb, type TestDb } from "../support/db";

let db: TestDb;
beforeAll(async () => {
  db = await withTestDb();
});
beforeEach(async () => {
  await db.reset();
  await db.pool.query("insert into budgets (scope, cap_micro_usd) values ('g', 100000000)");
});
afterAll(async () => {
  await db?.stop();
});

async function running(workerId = "w1"): Promise<{ id: string; claim: Claim }> {
  const id = await insertQueuedStage(db.pool, { videoId: uuidv7(), name: "draft", inputHash: "h" });
  const claim = await claimStage(db.pool, { id, inputHash: "h", workerId, ttlMs: 60_000 });
  if (!claim) throw new Error("claim failed");
  return { id, claim };
}
const out = (index: number, output: string, over: Partial<{ toolCallId: string; toolName: string; argsHash: string }> = {}) => ({
  index, toolCallId: `c${index}`, toolName: "t", argsHash: hashToolArgs({}), output, ...over,
});

describe("agent_steps store", () => {
  it("saves_and_loads_outputs_per_step_and_position", async () => {
    const { id, claim } = await running();
    const store = createPgAgentStepStore(db.pool, id);
    expect(await store.loadOutputs(0)).toBeNull();
    const saved = await store.saveOutputs(claim, 0, [out(0, "one"), out(1, "two")]);
    expect([...saved!.entries()].map(([i, v]) => [i, v.output])).toEqual([[0, "one"], [1, "two"]]);
    expect((await store.loadOutputs(0))!.get(1)!.output).toBe("two");
    expect(await store.loadOutputs(1)).toBeNull();
  });

  it("first_write_wins_and_the_save_returns_the_stored_value", async () => {
    const { id, claim } = await running();
    const store = createPgAgentStepStore(db.pool, id);
    await store.saveOutputs(claim, 0, [out(0, "first")]);
    const again = await store.saveOutputs(claim, 0, [out(0, "second")]);
    expect(again!.get(0)!.output).toBe("first");
  });

  it("stale_fence_cannot_save_outputs", async () => {
    const { id, claim } = await running();
    await db.pool.query("update stage_runs set status='queued', lease_owner=NULL, lease_until=NULL where id=$1", [id]);
    const fresh = await claimStage(db.pool, { id, inputHash: "h", workerId: "w2", ttlMs: 60_000 });
    expect(fresh!.fence).toBeGreaterThan(claim.fence);
    const store = createPgAgentStepStore(db.pool, id);
    expect(await store.saveOutputs(claim, 0, [out(0, "late")])).toBeNull();
    expect(await store.loadOutputs(0)).toBeNull();
    expect(await store.saveOutputs(fresh!, 0, [out(0, "ok")])).not.toBeNull();
  });

  it("a_stale_save_after_rows_exist_is_still_refused", async () => {
    const { id, claim } = await running();
    const store = createPgAgentStepStore(db.pool, id);
    await store.saveOutputs(claim, 0, [out(0, "x")]);
    await db.pool.query("update stage_runs set status='queued', lease_owner=NULL, lease_until=NULL where id=$1", [id]);
    await claimStage(db.pool, { id, inputHash: "h", workerId: "w2", ttlMs: 60_000 });
    expect(await store.saveOutputs(claim, 0, [out(0, "x")])).toBeNull();
  });

  it("a_finished_stage_cannot_be_written_to", async () => {
    const { id, claim } = await running();
    await db.pool.query("update stage_runs set status='succeeded' where id=$1", [id]);
    expect(await createPgAgentStepStore(db.pool, id).saveOutputs(claim, 0, [out(0, "x")])).toBeNull();
  });

  it("a_claim_for_another_stage_cannot_write_here", async () => {
    const a = await running();
    const b = await running("w2");
    expect(await createPgAgentStepStore(db.pool, a.id).saveOutputs(b.claim, 0, [out(0, "x")])).toBeNull();
  });

  it("odd_ids_nul_huge_text_and_secret_shapes_are_stored_safely", async () => {
    const { id, claim } = await running();
    const store = createPgAgentStepStore(db.pool, id);
    const saved = await store.saveOutputs(claim, 0, [
      out(0, "a\u0000b\ud800 key=sk-abcdefghij1234567890", { toolCallId: "x".repeat(300) + "\u0000" }),
      out(1, "x".repeat(200_000) + "\u0000", { toolCallId: "" }),
      out(2, "same", { toolCallId: "dup" }),
      out(3, "same", { toolCallId: "dup" }),
    ]);
    expect(saved!.size).toBe(4);
    expect(saved!.get(0)!.output).not.toContain("sk-abcdefghij1234567890");
    expect(saved!.get(0)!.output).toMatch(/^ab/);
    expect(saved!.get(0)!.toolCallId.length).toBe(200);
    expect(Buffer.byteLength(saved!.get(1)!.output)).toBeLessThanOrEqual(TOOL_OUTPUT_MAX_BYTES);
  });

  it("records_the_fence_of_the_writer", async () => {
    const { id, claim } = await running();
    await createPgAgentStepStore(db.pool, id).saveOutputs(claim, 2, [out(0, "x")]);
    const { rows } = await db.pool.query("select fence from agent_steps where stage_run_id=$1", [id]);
    expect(Number(rows[0].fence)).toBe(claim.fence);
  });

  it("app_role_cannot_update_delete_or_truncate_but_prune_removes_old_rows", async () => {
    const { id, claim } = await running();
    await createPgAgentStepStore(db.pool, id).saveOutputs(claim, 0, [out(0, "x")]);
    await expect(db.pool.query("update agent_steps set output='y'")).rejects.toThrow(/permission denied/);
    await expect(db.pool.query("delete from agent_steps")).rejects.toThrow(/permission denied/);
    await expect(db.pool.query("truncate agent_steps")).rejects.toThrow(/permission denied/);
    expect(await pruneAgentSteps(db.pool)).toBe(0);
    await db.ownerPool.query("update agent_steps set created_at = clock_timestamp() - interval '8 days'");
    expect(await pruneAgentSteps(db.pool)).toBe(1);
  });
});

describe("runAgent against the Postgres store", () => {
  const price = { inputPerMTokMicro: 1_000_000, outputPerMTokMicro: 5_000_000 };
  const res = (text: string, calls: StepResult["toolCalls"] = []): StepResult => ({
    text, toolCalls: calls, usage: { inputTokens: 100, outputTokens: 20 },
  });

  it("a_resumed_stage_makes_no_repeat_model_or_tool_calls_and_two_runs_in_one_stage_do_not_collide", async () => {
    const { id, claim } = await running();
    const ports = createPgPaidCallPorts(db.pool);
    const store = createPgAgentStepStore(db.pool, id);
    const modelCalls = { n: 0 };
    const toolRuns = { n: 0 };
    const go = (ordinal: number, q: string) => {
      const script = [res("", [{ id: "call_0", name: "search", args: { q } }]), res(`answer ${q}`)];
      let i = 0;
      const step: ModelStep = async () => (modelCalls.n++, script[i++]!);
      return runAgent({
        claim, ports, store, runOrdinal: ordinal, price, budgetScopes: ["g"], maxOutputTokens: 100, maxSteps: 4, step,
        tools: [{ name: "search", run: async () => (toolRuns.n++, `found ${q}`) }],
        messages: [{ role: "user", content: q }],
      });
    };
    const first = await go(0, "alpha");
    expect([modelCalls.n, toolRuns.n]).toEqual([2, 1]);
    // Same stage resumed: nothing repeats.
    const again = await go(0, "alpha");
    expect([modelCalls.n, toolRuns.n]).toEqual([2, 1]);
    expect(again.messages).toEqual(first.messages);
    // A second agent run in the same stage (same provider tool id, other ordinal) does its own work.
    const second = await go(1, "beta");
    expect([modelCalls.n, toolRuns.n]).toEqual([4, 2]);
    expect(second.text).toBe("answer beta");
    expect(first.text).toBe("answer alpha");
  });

  it("a_non_deterministic_tool_is_replayed_from_the_store_not_rerun", async () => {
    const { id, claim } = await running();
    const ports = createPgPaidCallPorts(db.pool);
    const store = createPgAgentStepStore(db.pool, id);
    let n = 0;
    const go = () => {
      const script = [res("", [{ id: "t", name: "rnd", args: {} }]), res("done")];
      let i = 0;
      return runAgent({
        claim, ports, store, price, budgetScopes: ["g"], maxOutputTokens: 100, maxSteps: 4,
        step: vi.fn<ModelStep>(async () => script[i++]!),
        tools: [{ name: "rnd", run: async () => `value ${++n}` }],
        messages: [{ role: "user", content: "x" }],
      });
    };
    const first = await go();
    const second = await go();
    expect(n).toBe(1);
    expect(second.messages).toEqual(first.messages);
  });
});
