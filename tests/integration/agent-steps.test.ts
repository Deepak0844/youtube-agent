import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createPgAgentStepStore } from "@/server/db/agent-steps";
import { TOOL_OUTPUT_MAX_BYTES } from "@/server/core/agent-loop";
import { claimStage, insertQueuedStage, type Claim } from "@/server/db/stages";
import { uuidv7 } from "@/server/core/ids";
import { withTestDb, type TestDb } from "../support/db";

let db: TestDb;
beforeAll(async () => {
  db = await withTestDb();
});
beforeEach(async () => {
  await db.reset();
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

describe("agent_steps store", () => {
  it("saves_and_loads_outputs_per_step", async () => {
    const { id, claim } = await running();
    const store = createPgAgentStepStore(db.pool, id);
    expect(await store.loadOutputs(0)).toBeNull();
    expect(await store.saveOutputs(claim, 0, [{ toolCallId: "a", output: "one" }, { toolCallId: "b", output: "two" }])).toBe(true);
    expect(await store.loadOutputs(0)).toEqual(new Map([["a", "one"], ["b", "two"]]));
    expect(await store.loadOutputs(1)).toBeNull();
  });

  it("first_write_wins_so_a_replay_never_changes_a_stored_output", async () => {
    const { id, claim } = await running();
    const store = createPgAgentStepStore(db.pool, id);
    await store.saveOutputs(claim, 0, [{ toolCallId: "a", output: "first" }]);
    expect(await store.saveOutputs(claim, 0, [{ toolCallId: "a", output: "second" }])).toBe(true);
    expect((await store.loadOutputs(0))!.get("a")).toBe("first");
  });

  it("stale_fence_cannot_save_outputs", async () => {
    const { id, claim } = await running();
    // The lease expires and another worker claims the stage: the old claim's fence is now stale.
    await db.pool.query("update stage_runs set status='queued', lease_owner=NULL, lease_until=NULL where id=$1", [id]);
    const fresh = await claimStage(db.pool, { id, inputHash: "h", workerId: "w2", ttlMs: 60_000 });
    expect(fresh!.fence).toBeGreaterThan(claim.fence);
    const store = createPgAgentStepStore(db.pool, id);
    expect(await store.saveOutputs(claim, 0, [{ toolCallId: "a", output: "late" }])).toBe(false);
    expect(await store.loadOutputs(0)).toBeNull();
    expect(await store.saveOutputs(fresh!, 0, [{ toolCallId: "a", output: "ok" }])).toBe(true);
  });

  it("a_finished_stage_cannot_be_written_to", async () => {
    const { id, claim } = await running();
    await db.pool.query("update stage_runs set status='succeeded' where id=$1", [id]);
    const store = createPgAgentStepStore(db.pool, id);
    expect(await store.saveOutputs(claim, 0, [{ toolCallId: "a", output: "x" }])).toBe(false);
  });

  it("a_claim_for_another_stage_cannot_write_here", async () => {
    const a = await running();
    const b = await running("w2");
    const store = createPgAgentStepStore(db.pool, a.id);
    expect(await store.saveOutputs(b.claim, 0, [{ toolCallId: "a", output: "x" }])).toBe(false);
  });

  it("tool_output_with_nul_or_huge_text_is_stored_safely", async () => {
    const { id, claim } = await running();
    const store = createPgAgentStepStore(db.pool, id);
    const huge = "x".repeat(200_000) + "\u0000";
    expect(
      await store.saveOutputs(claim, 0, [
        { toolCallId: "nul", output: "a\u0000b\ud800 key=sk-abcdefghij1234567890" },
        { toolCallId: "huge", output: huge },
      ]),
    ).toBe(true);
    const got = (await store.loadOutputs(0))!;
    expect(got.get("nul")).not.toContain("sk-abcdefghij1234567890");
    expect(got.get("nul")).toMatch(/^ab/);
    expect(Buffer.byteLength(got.get("huge")!)).toBeLessThanOrEqual(TOOL_OUTPUT_MAX_BYTES);
  });

  it("records_the_fence_of_the_writer", async () => {
    const { id, claim } = await running();
    await createPgAgentStepStore(db.pool, id).saveOutputs(claim, 2, [{ toolCallId: "a", output: "x" }]);
    const { rows } = await db.pool.query("select fence from agent_steps where stage_run_id=$1", [id]);
    expect(Number(rows[0].fence)).toBe(claim.fence);
  });
});
