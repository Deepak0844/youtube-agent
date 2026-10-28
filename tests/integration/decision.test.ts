import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildEngineConfig } from "@/server/core/engine-config";
import { callKey } from "@/server/core/spend";
import type { StageHandler } from "@/server/core/stage-handler";
import type { StageRunnerDeps } from "@/server/core/stage-runner";
import { recordBreakerEvent } from "@/server/db/breakers";
import { getDecision, resolveDecision } from "@/server/db/decision";
import { advanceVideo } from "@/server/db/pipeline";
import { reconcile } from "@/server/db/reconciler";
import { getBudget, settleIntent } from "@/server/db/spend";
import { runStage } from "@/server/db/stage-runner-adapter";
import { getStage } from "@/server/db/stages";
import { createVideoRow } from "@/server/db/videos";
import { createFakeProvider, type FakeProvider } from "../support/fake-provider";
import { withTestDb, type TestDb } from "../support/db";

let db: TestDb;
let provider: FakeProvider;
beforeAll(async () => {
  db = await withTestDb();
});
afterAll(async () => {
  await db?.stop();
});
beforeEach(async () => {
  await db.reset();
  await db.ownerPool.query(await readFile("src/server/db/migrations/0014_breakers.sql", "utf8"));
  provider = createFakeProvider({ pool: db.pool });
  await provider.init();
  await db.ownerPool.query("truncate fake_provider_calls");
  await db.pool.query("insert into budgets (scope, cap_micro_usd) values ('g', 100000000)");
  await db.ownerPool.query(
    "insert into sessions (id, token_hash, expires_at, absolute_expires_at) values ($1, 'decision-test', clock_timestamp() + interval '1 day', clock_timestamp() + interval '7 days')",
    [SESSION_ID],
  );
});

const SESSION_ID = "0190f3a2-7c1e-7a55-9d3b-2f6c8a1b4e90";
const SESSION = { kind: "session", sessionId: SESSION_ID } as const;
const input = { format: "short", kind: "scene_kit", language: "en", topic: "Why the sky is blue" } as const;
const config = buildEngineConfig(new Map());
const RESERVE = 400_000;

interface FakeQueue {
  calls: Array<{ id: string; fence: number; attemptSeq: number; inputHash: string }>;
  failNext: number;
  enqueue(id: string, fence: number, attemptSeq: number, inputHash: string): Promise<string>;
  liveJobIds(): Promise<Set<string>>;
}
function fakeQueue(): FakeQueue {
  const q: FakeQueue = {
    calls: [],
    failNext: 0,
    async enqueue(id, fence, attemptSeq, inputHash) {
      if (q.failNext > 0) {
        q.failNext--;
        throw new Error("redis down");
      }
      q.calls.push({ id, fence, attemptSeq, inputHash });
      return `stage.${id}.${fence}.${attemptSeq}`;
    },
    async liveJobIds() {
      return new Set(q.calls.map((c) => `stage.${c.id}.${c.fence}.${c.attemptSeq}`));
    },
  };
  return q;
}

const step = (over = {}) => ({ reserveMicroUsd: RESERVE, budgetScopes: ["g"], kind: "paid" as const, ...over });
const deps = (handler: StageHandler, over: Partial<StageRunnerDeps> = {}): StageRunnerDeps => ({ provider: { call: (key) => provider.call(key) }, ttlMs: 5000, workerId: "w", handler, config, ...over });
const stagesOf = async (videoId: string, name = "draft") =>
  (await db.pool.query("select id, status, input_hash, cancel_requested, attempt_seq, result from stage_runs where video_id = $1 and name = $2 order by created_at, id", [videoId, name])).rows as Array<{
    id: string; status: string; input_hash: string; cancel_requested: boolean; attempt_seq: number; result: Record<string, unknown> | null;
  }>;
const intentsOf = async (stageId: string) => (await db.pool.query("select id, status, reserved_micro_usd::int as reserved, actual_micro_usd::int as actual, actual_invalid from spend_intents where stage_run_id = $1 order by call_key", [stageId])).rows;
const auditRows = async () => (await db.ownerPool.query("select event, detail from audit_log where event = 'stage.decision' order by id")).rows;
const g = async () => (await getBudget(db.pool, "g"))!;

/** A real draft stage whose paid call died with an unclear outcome, parked by the reconciler (the production path). */
async function parkUnknown(q: FakeQueue, reserve = RESERVE) {
  const v = await createVideoRow(db.pool, input);
  await advanceVideo(db.pool, q, v.id);
  const [d] = await stagesOf(v.id);
  const row = (await getStage(db.pool, d!.id))!;
  const handler: StageHandler = (ctx) => ctx.paid(step({ kind: "cheap_text", reserveMicroUsd: reserve }), async () => {
    throw new Error("socket hang up"); // sent, no answer: the outcome is unknown
  });
  await expect(runStage(db.pool, deps(handler, { ttlMs: 300 }), { stageRunId: d!.id, inputHash: row.inputHash })).rejects.toThrow(/socket hang up/);
  await db.ownerPool.query("update stage_runs set lease_until = clock_timestamp() - interval '1 second' where id = $1", [d!.id]);
  const rec = await reconcile(db.pool, q, { graceMs: 0 });
  expect(rec.needsDecision).toEqual([d!.id]);
  q.calls.length = 0;
  return { videoId: v.id, stageId: d!.id };
}

/** call 0 paid and settled, call 1 died with an unclear outcome: the stage is parked with BOTH a done and an unknown call. */
async function parkMixed(q: FakeQueue) {
  const v = await createVideoRow(db.pool, input);
  await advanceVideo(db.pool, q, v.id);
  const [d] = await stagesOf(v.id);
  const row = (await getStage(db.pool, d!.id))!;
  const handler: StageHandler = async (ctx) => {
    await ctx.paid(step(), (key) => provider.call(key));
    return ctx.paid(step({ kind: "cheap_text" }), async () => {
      throw new Error("socket hang up");
    });
  };
  await expect(runStage(db.pool, deps(handler, { ttlMs: 300 }), { stageRunId: d!.id, inputHash: row.inputHash })).rejects.toThrow(/socket hang up/);
  await db.ownerPool.query("update stage_runs set lease_until = clock_timestamp() - interval '1 second' where id = $1", [d!.id]);
  expect((await reconcile(db.pool, q, { graceMs: 0 })).needsDecision).toEqual([d!.id]);
  q.calls.length = 0;
  return { videoId: v.id, stageId: d!.id };
}

/** With a done call: call 0 paid on scope g, then g's cap drops below what is spent, so call 1 is refused. Without: refused at once. */
async function parkRefused(q: FakeQueue, withDone = true) {
  const v = await createVideoRow(db.pool, input);
  await advanceVideo(db.pool, q, v.id);
  const [d] = await stagesOf(v.id);
  const row = (await getStage(db.pool, d!.id))!;
  if (!withDone) await db.pool.query("update budgets set cap_micro_usd = 100 where scope = 'g'");
  const handler: StageHandler = async (ctx) => {
    if (withDone) {
      await ctx.paid(step(), (key) => provider.call(key));
      await db.pool.query("update budgets set cap_micro_usd = 100 where scope = 'g'");
    }
    return ctx.paid(step(), (key) => provider.call(key));
  };
  expect((await runStage(db.pool, deps(handler), { stageRunId: d!.id, inputHash: row.inputHash })).kind).toBe("budget_refused");
  q.calls.length = 0;
  return { videoId: v.id, stageId: d!.id };
}

const payOnce: StageHandler = (ctx) => ctx.paid(step(), (key) => provider.call(key));

describe("needs_decision resolution", () => {
  it("release_returns_the_reservation_and_reruns_with_new_call_keys", async () => {
    const q = fakeQueue();
    const { videoId, stageId } = await parkUnknown(q);
    expect(await g()).toMatchObject({ reservedMicroUsd: RESERVE, spentMicroUsd: 0 });
    const view = await getDecision(db.pool, stageId);
    expect(view).toMatchObject({ reason: "paid_call_may_have_run", maxCostMicroUsd: RESERVE });

    const r = await resolveDecision(db.pool, q, { stageRunId: stageId, choice: "release_and_rerun", actor: SESSION });
    expect(r).toMatchObject({ ok: true });
    expect(await g()).toMatchObject({ reservedMicroUsd: 0, spentMicroUsd: 0 });
    expect((await intentsOf(stageId)).map((i) => i.status)).toEqual(["failed_known"]);
    const rows = await stagesOf(videoId);
    expect(rows.map((x) => x.status)).toEqual(["failed", "queued"]);
    const fresh = rows[1]!;
    expect(fresh.id).not.toBe(stageId);
    expect(fresh.input_hash).toBe(rows[0]!.input_hash);
    expect(q.calls).toHaveLength(1);
    expect(q.calls[0]).toMatchObject({ id: fresh.id, inputHash: fresh.input_hash });
    expect((await db.pool.query("select status from videos where id = $1", [videoId])).rows[0].status).toBe("active");

    // the rerun pays under its own keys; the old key is never called
    const out = await runStage(db.pool, deps(payOnce), { stageRunId: fresh.id, inputHash: fresh.input_hash });
    expect(out.kind).toBe("committed");
    expect(await provider.dbCalls(callKey(fresh.id, 0, 0))).toBe(1);
    expect(await provider.dbCalls(callKey(stageId, 0, 0))).toBe(0);
    expect(callKey(fresh.id, 0, 0)).not.toBe(callKey(stageId, 0, 0));

    // audit + live feed
    const audit = await auditRows();
    expect(audit).toHaveLength(1);
    expect(audit[0].detail).toMatchObject({ stageRunId: stageId, videoId, choice: "release_and_rerun", reason: "paid_call_may_have_run", sessionId: SESSION_ID, maxCostMicroUsd: RESERVE });
    const ev = await db.ownerPool.query("select type, payload from events where stage_run_id = $1 and type = 'notify'", [stageId]);
    expect(ev.rowCount).toBe(1);
    expect(ev.rows[0].payload).toMatchObject({ kind: "decision", choice: "release_and_rerun" });
  });

  it("keep_spent_counts_the_money_and_reruns", async () => {
    const q = fakeQueue();
    const { videoId, stageId } = await parkUnknown(q);
    expect(await resolveDecision(db.pool, q, { stageRunId: stageId, choice: "keep_spent_and_rerun", actor: SESSION })).toMatchObject({ ok: true });
    expect(await g()).toMatchObject({ reservedMicroUsd: 0, spentMicroUsd: RESERVE });
    expect(await intentsOf(stageId)).toMatchObject([{ status: "done", actual: RESERVE, actual_invalid: true }]);
    expect((await stagesOf(videoId)).map((x) => x.status)).toEqual(["failed", "queued"]);
    expect(q.calls).toHaveLength(1);
    expect((await auditRows())[0].detail).toMatchObject({ choice: "keep_spent_and_rerun" });
  });

  it("late_settled_done_stage_can_use_the_result_only_when_input_hash_matches", async () => {
    // matching hash: the SAME row goes back to the queue; its settled call is replayed, never paid again
    const q = fakeQueue();
    const { videoId, stageId } = await parkUnknown(q);
    const [intent] = await intentsOf(stageId);
    await settleIntent(db.pool, intent.id, { actualMicroUsd: 123_000, result: { late: true } });
    expect(await getDecision(db.pool, stageId)).toMatchObject({ reason: "settled_late", maxCostMicroUsd: 0, choices: ["use_result", "cancel_video"] });
    expect(await resolveDecision(db.pool, q, { stageRunId: stageId, choice: "release_and_rerun", actor: SESSION })).toMatchObject({ ok: false });
    expect(await resolveDecision(db.pool, q, { stageRunId: stageId, choice: "use_result", actor: SESSION })).toMatchObject({ ok: true });
    const rows = await stagesOf(videoId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("queued");
    expect(rows[0]!.attempt_seq).toBe(1);
    expect(q.calls).toEqual([expect.objectContaining({ id: stageId, attemptSeq: 1 })]);
    const row = (await getStage(db.pool, stageId))!;
    const replay: StageHandler = (ctx) => ctx.paid(step({ kind: "cheap_text" }), async () => {
      throw new Error("must not be called again");
    });
    expect((await runStage(db.pool, deps(replay), { stageRunId: stageId, inputHash: row.inputHash })).kind).toBe("committed");
    expect(await g()).toMatchObject({ reservedMicroUsd: 0, spentMicroUsd: 123_000 });

    // changed input: refused, the row stays parked
    const q2 = fakeQueue();
    const v2 = await parkUnknown(q2);
    const [i2] = await intentsOf(v2.stageId);
    await settleIntent(db.pool, i2.id, { actualMicroUsd: 1, result: null });
    await db.ownerPool.query("update videos set topic = 'A different topic' where id = $1", [v2.videoId]);
    const bad = await resolveDecision(db.pool, q2, { stageRunId: v2.stageId, choice: "use_result", actor: SESSION });
    expect(bad).toMatchObject({ ok: false });
    expect((await getStage(db.pool, v2.stageId))!.status).toBe("needs_decision");
    expect(q2.calls).toHaveLength(0);
  });

  it("cancel_video_releases_nothing_that_may_have_run", async () => {
    const q = fakeQueue();
    const { videoId, stageId } = await parkUnknown(q);
    expect(await resolveDecision(db.pool, q, { stageRunId: stageId, choice: "cancel_video", actor: SESSION })).toMatchObject({ ok: true });
    expect((await db.pool.query("select status from videos where id = $1", [videoId])).rows[0].status).toBe("cancelled");
    expect(await g()).toMatchObject({ reservedMicroUsd: RESERVE, spentMicroUsd: 0 }); // still held
    expect((await intentsOf(stageId)).map((i) => i.status)).toEqual(["unknown"]);
    const row = await getStage(db.pool, stageId);
    expect(row).toMatchObject({ status: "needs_decision", cancelRequested: true }); // held money is never hidden
    expect(await stagesOf(videoId)).toHaveLength(1);
    expect(q.calls).toHaveLength(0);
    expect((await auditRows())[0].detail).toMatchObject({ choice: "cancel_video" });

    // later the owner can still settle the money: no new row, the old one is closed as cancelled
    expect(await resolveDecision(db.pool, q, { stageRunId: stageId, choice: "keep_spent_and_rerun", actor: SESSION })).toMatchObject({ ok: true });
    expect(await g()).toMatchObject({ reservedMicroUsd: 0, spentMicroUsd: RESERVE });
    expect(await stagesOf(videoId)).toMatchObject([{ status: "cancelled" }]);
    expect(q.calls).toHaveLength(0);
  });

  it("token_job_system_cannot_resolve", async () => {
    const q = fakeQueue();
    const { stageId } = await parkUnknown(q);
    const revoked = "0190f3a2-7c1e-7a55-9d3b-2f6c8a1b4e91";
    await db.ownerPool.query("insert into sessions (id, token_hash, expires_at, absolute_expires_at, revoked_at) values ($1, 'x', clock_timestamp() + interval '1 day', clock_timestamp() + interval '7 days', clock_timestamp())", [revoked]);
    const actors: unknown[] = [
      { kind: "token", sessionId: SESSION_ID },
      { kind: "job", sessionId: SESSION_ID },
      { kind: "system", sessionId: SESSION_ID },
      { kind: "session" },
      { kind: "session", sessionId: "not-a-uuid" },
      { kind: "session", sessionId: SESSION_ID, extra: 1 },
      { kind: "session", sessionId: "0190f3a2-7c1e-7a55-9d3b-2f6c8a1b4e99" }, // well formed but no such session
      { kind: "session", sessionId: revoked },
      null,
      "owner",
    ];
    for (const choice of ["release_and_rerun", "keep_spent_and_rerun", "cancel_video"] as const) {
      for (const actor of actors) {
        expect(await resolveDecision(db.pool, q, { stageRunId: stageId, choice, actor: actor as never }), `${choice} ${JSON.stringify(actor)}`).toMatchObject({ ok: false });
      }
    }
    expect(await g()).toMatchObject({ reservedMicroUsd: RESERVE, spentMicroUsd: 0 });
    expect((await intentsOf(stageId)).map((i) => i.status)).toEqual(["unknown"]);
    expect((await getStage(db.pool, stageId))!.status).toBe("needs_decision");
    expect(await auditRows()).toHaveLength(0);
    expect(q.calls).toHaveLength(0);
  });

  it("two_resolves_race_exactly_one_wins", async () => {
    for (const [a, b] of [["release_and_rerun", "release_and_rerun"], ["release_and_rerun", "keep_spent_and_rerun"], ["keep_spent_and_rerun", "keep_spent_and_rerun"]] as const) {
      await db.reset();
      await db.ownerPool.query(await readFile("src/server/db/migrations/0014_breakers.sql", "utf8"));
      await db.pool.query("insert into budgets (scope, cap_micro_usd) values ('g', 100000000)");
      await db.ownerPool.query("insert into sessions (id, token_hash, expires_at, absolute_expires_at) values ($1, 'decision-test', clock_timestamp() + interval '1 day', clock_timestamp() + interval '7 days')", [SESSION_ID]);
      const q = fakeQueue();
      const { videoId, stageId } = await parkUnknown(q);
      const results = await Promise.all([a, b].map((choice) => resolveDecision(db.pool, q, { stageRunId: stageId, choice, actor: SESSION })));
      expect(results.filter((r) => r.ok), `${a}/${b}`).toHaveLength(1);
      expect(results.find((r) => !r.ok)).toMatchObject({ ok: false, reason: expect.stringMatching(/already|no longer/i) });
      expect(await stagesOf(videoId)).toHaveLength(2); // exactly one new row
      expect(q.calls).toHaveLength(1);
      expect(await auditRows()).toHaveLength(1);
      const b1 = await g();
      expect(b1.reservedMicroUsd).toBe(0);
      expect([0, RESERVE]).toContain(b1.spentMicroUsd); // one outcome, never both, never half
    }
  });

  it("reconciler_never_touches_a_needs_decision_row_even_after_resolve_started", async () => {
    const q = fakeQueue();
    const { videoId, stageId } = await parkUnknown(q);
    await db.ownerPool.query("update stage_runs set updated_at = clock_timestamp() - interval '1 hour' where id = $1", [stageId]);
    // before: untouched
    expect(await reconcile(db.pool, q, { graceMs: 0 })).toMatchObject({ requeued: [], failed: [], needsDecision: [] });
    expect((await getStage(db.pool, stageId))!.status).toBe("needs_decision");
    // during and after: a resolve racing several sweeps leaves exactly one live row and one delivery
    const [res] = await Promise.all([
      resolveDecision(db.pool, q, { stageRunId: stageId, choice: "release_and_rerun", actor: SESSION }),
      reconcile(db.pool, q, { graceMs: 0 }),
      reconcile(db.pool, q, { graceMs: 0 }),
    ]);
    expect(res).toMatchObject({ ok: true });
    await reconcile(db.pool, q, { graceMs: 0 });
    const rows = await stagesOf(videoId);
    expect(rows.map((r) => r.status)).toEqual(["failed", "queued"]);
    expect(rows[0]!.attempt_seq).toBe(0); // the parked row was never requeued
    expect(q.calls.filter((c) => c.id === stageId)).toHaveLength(0);
  });

  it("budget_refused_choice_raise_cap_needs_session", async () => {
    const q = fakeQueue();
    const v = await createVideoRow(db.pool, input);
    await advanceVideo(db.pool, q, v.id);
    const [d] = await stagesOf(v.id);
    await db.pool.query("update budgets set cap_micro_usd = 100 where scope = 'g'");
    const row = (await getStage(db.pool, d!.id))!;
    expect((await runStage(db.pool, deps(payOnce), { stageRunId: d!.id, inputHash: row.inputHash })).kind).toBe("budget_refused");
    q.calls.length = 0;
    expect(await getDecision(db.pool, d!.id)).toMatchObject({ reason: "budget_refused", choices: ["raise_cap_and_rerun", "cancel_video"] });

    const raise = (actor: unknown, cap = 5_000_000, scope = "g") => resolveDecision(db.pool, q, { stageRunId: d!.id, choice: "raise_cap_and_rerun", actor: actor as never, raiseCap: { scope, capMicroUsd: cap } });
    for (const actor of [{ kind: "token", sessionId: SESSION_ID }, { kind: "job" }, { kind: "system" }, null]) expect(await raise(actor)).toMatchObject({ ok: false });
    expect(await raise(SESSION, 50)).toMatchObject({ ok: false }); // not higher
    expect(await raise(SESSION, 5_000_000, "nope")).toMatchObject({ ok: false }); // unknown scope
    expect(await raise(SESSION, 2 ** 60)).toMatchObject({ ok: false }); // not a safe integer
    expect(await resolveDecision(db.pool, q, { stageRunId: d!.id, choice: "raise_cap_and_rerun", actor: SESSION })).toMatchObject({ ok: false }); // no new cap given
    expect(await resolveDecision(db.pool, q, { stageRunId: d!.id, choice: "release_and_rerun", actor: SESSION })).toMatchObject({ ok: false }); // not offered here
    expect((await g()).capMicroUsd).toBe(100);
    expect((await getStage(db.pool, d!.id))!.status).toBe("needs_decision");
    expect(await auditRows()).toHaveLength(0);

    expect(await raise(SESSION)).toMatchObject({ ok: true });
    expect((await g()).capMicroUsd).toBe(5_000_000);
    expect((await getStage(db.pool, d!.id))!.status).toBe("queued"); // same row: nothing was paid, the refused key was never used
    expect(q.calls).toHaveLength(1);
    expect((await auditRows())[0].detail).toMatchObject({ choice: "raise_cap_and_rerun", scope: "g", oldCapMicroUsd: 100, newCapMicroUsd: 5_000_000 });
    expect((await runStage(db.pool, deps(payOnce), { stageRunId: d!.id, inputHash: row.inputHash })).kind).toBe("committed");
  });

  it("a_choice_not_offered_for_the_state_changes_nothing", async () => {
    const q = fakeQueue();
    const { stageId } = await parkUnknown(q);
    for (const choice of ["use_result", "raise_cap_and_rerun"] as const) {
      expect(await resolveDecision(db.pool, q, { stageRunId: stageId, choice, actor: SESSION, raiseCap: { scope: "g", capMicroUsd: 999_999_999 } })).toMatchObject({ ok: false });
    }
    expect(await resolveDecision(db.pool, q, { stageRunId: stageId, choice: "bogus" as never, actor: SESSION })).toMatchObject({ ok: false });
    expect(await resolveDecision(db.pool, q, { stageRunId: "not-a-uuid", choice: "cancel_video", actor: SESSION })).toMatchObject({ ok: false });
    expect(await resolveDecision(db.pool, q, { stageRunId: "0190f3a2-7c1e-7a55-9d3b-2f6c8a1b4e77", choice: "cancel_video", actor: SESSION })).toMatchObject({ ok: false });
    expect((await g())).toMatchObject({ capMicroUsd: 100_000_000, reservedMicroUsd: RESERVE });
    expect(await auditRows()).toHaveLength(0);
  });

  it("a_stage_that_is_not_parked_cannot_be_resolved", async () => {
    const q = fakeQueue();
    const v = await createVideoRow(db.pool, input);
    await advanceVideo(db.pool, q, v.id);
    const [d] = await stagesOf(v.id);
    expect(await resolveDecision(db.pool, q, { stageRunId: d!.id, choice: "release_and_rerun", actor: SESSION })).toMatchObject({ ok: false });
    expect(await getDecision(db.pool, d!.id)).toBeNull();
  });

  it("a_parked_synthetic_test_or_eval_stage_is_closed_without_a_rerun", async () => {
    const NIL = "00000000-0000-0000-0000-000000000000";
    for (const name of ["model_test", "llm_eval"]) {
      const id = `0190f3a2-7c1e-7a55-9d3b-2f6c8a1b4f0${name === "model_test" ? 1 : 2}`;
      await db.ownerPool.query("insert into stage_runs (id, video_id, name, status, input_hash, result) values ($1, $2, $3, 'needs_decision', 'h', '{\"needsDecision\":\"x\"}')", [id, NIL, name]);
      await db.ownerPool.query("insert into spend_intents (id, stage_run_id, step_index, tool_call_index, call_key, status, reserved_micro_usd, scopes) values (gen_random_uuid(), $1, 0, 0, $2, 'unknown', 250000, '{g}')", [id, callKey(id, 0, 0)]);
      await db.ownerPool.query("update budgets set reserved_micro_usd = reserved_micro_usd + 250000 where scope = 'g'");
      const q = fakeQueue();
      expect(await getDecision(db.pool, id)).toMatchObject({ reason: "paid_call_may_have_run", maxCostMicroUsd: 250000 });
      expect(await resolveDecision(db.pool, q, { stageRunId: id, choice: "cancel_video", actor: SESSION })).toMatchObject({ ok: false }); // no video to cancel
      expect(await resolveDecision(db.pool, q, { stageRunId: id, choice: "release_and_rerun", actor: SESSION })).toMatchObject({ ok: true });
      expect((await getStage(db.pool, id))!.status).toBe("failed");
      expect(q.calls).toHaveLength(0);
      expect(await g()).toMatchObject({ reservedMicroUsd: 0 });
      expect((await db.pool.query("select count(*)::int as n from stage_runs where name = $1", [name])).rows[0].n).toBe(1);
    }
  });

  it("a_redis_outage_after_commit_leaves_a_queued_row_the_reconciler_delivers", async () => {
    const q = fakeQueue();
    const { videoId, stageId } = await parkUnknown(q);
    q.failNext = 1;
    expect(await resolveDecision(db.pool, q, { stageRunId: stageId, choice: "release_and_rerun", actor: SESSION })).toMatchObject({ ok: true });
    const rows = await stagesOf(videoId);
    expect(rows.map((r) => r.status)).toEqual(["failed", "queued"]);
    expect(q.calls).toHaveLength(0);
    await db.ownerPool.query("update stage_runs set updated_at = clock_timestamp() - interval '1 hour' where id = $1", [rows[1]!.id]);
    await reconcile(db.pool, q, { graceMs: 0 });
    expect(q.calls.map((c) => c.id)).toEqual([rows[1]!.id]);
  });

  it("a_stage_with_a_done_call_and_an_unknown_call_is_never_rerun_with_fresh_keys", async () => {
    for (const choice of ["release_and_rerun", "keep_spent_and_rerun", "cancel_video", "use_result", "raise_cap_and_rerun"] as const) {
      await db.reset();
      await db.ownerPool.query(await readFile("src/server/db/migrations/0014_breakers.sql", "utf8"));
      await db.pool.query("insert into budgets (scope, cap_micro_usd) values ('g', 100000000)");
      await db.ownerPool.query("insert into sessions (id, token_hash, expires_at, absolute_expires_at) values ($1, 'decision-test', clock_timestamp() + interval '1 day', clock_timestamp() + interval '7 days')", [SESSION_ID]);
      const q = fakeQueue();
      const { videoId, stageId } = await parkMixed(q);
      const before = await g();
      expect(await getDecision(db.pool, stageId), choice).toMatchObject({ rerunSafe: false, choices: ["release_and_rerun", "keep_spent_and_rerun", "cancel_video"] });
      const r = await resolveDecision(db.pool, q, { stageRunId: stageId, choice, actor: SESSION, raiseCap: { scope: "g", capMicroUsd: 999_999 } });
      const rows = await stagesOf(videoId);
      expect(rows, choice).toHaveLength(1); // never a second row, so call 0 can never be paid again
      expect(q.calls, choice).toHaveLength(0);
      const intents = await intentsOf(stageId);
      expect(intents[0]!.status).toBe("done"); // the paid call is never touched
      if (choice === "use_result" || choice === "raise_cap_and_rerun") {
        expect(r).toMatchObject({ ok: false });
        expect(rows[0]!.status).toBe("needs_decision");
        expect(await g()).toEqual(before);
      } else if (choice === "cancel_video") {
        expect(r).toMatchObject({ ok: true });
        expect(rows[0]!.status).toBe("needs_decision"); // open money keeps the row visible
        expect(await g()).toEqual(before);
      } else {
        expect(r).toMatchObject({ ok: true });
        expect(rows[0]!.status).toBe("failed"); // settled and closed, no rerun
        expect(r).not.toHaveProperty("newStageRunId");
        const after = await g();
        expect(after.reservedMicroUsd).toBe(0);
        expect(after.spentMicroUsd).toBe(before.spentMicroUsd + (choice === "keep_spent_and_rerun" ? RESERVE : 0));
        expect(intents[1]!.status).toBe(choice === "keep_spent_and_rerun" ? "done" : "failed_known");
      }
    }
  });

  it("an_open_breaker_still_settles_the_money_but_holds_the_rerun", async () => {
    const q = fakeQueue();
    const { videoId, stageId } = await parkUnknown(q);
    for (let n = 0; n < 5; n++) await recordBreakerEvent(db.pool, "draft", "failure");
    const r = await resolveDecision(db.pool, q, { stageRunId: stageId, choice: "release_and_rerun", actor: SESSION });
    expect(r).toMatchObject({ ok: true, rerunHeld: true });
    expect(await g()).toMatchObject({ reservedMicroUsd: 0, spentMicroUsd: 0 });
    expect((await intentsOf(stageId)).map((i) => i.status)).toEqual(["failed_known"]);
    expect((await stagesOf(videoId)).map((x) => x.status)).toEqual(["failed"]); // closed, no new row
    expect(q.calls).toHaveLength(0);
  });

  it("an_open_breaker_refuses_raise_cap_which_is_all_rerun", async () => {
    const q = fakeQueue();
    const { stageId } = await parkRefused(q, false);
    for (let n = 0; n < 5; n++) await recordBreakerEvent(db.pool, "draft", "failure");
    expect(await resolveDecision(db.pool, q, { stageRunId: stageId, choice: "raise_cap_and_rerun", actor: SESSION, raiseCap: { scope: "g", capMicroUsd: 5_000_000 } })).toMatchObject({ ok: false, reason: expect.stringMatching(/paused/i) });
    expect((await g()).capMicroUsd).toBe(100);
    expect((await getStage(db.pool, stageId))!.status).toBe("needs_decision");
  });

  it("half_open_probe_is_spent_only_by_a_rerun_that_really_happens", async () => {
    const probe = async () => (await db.ownerPool.query("select probe_at from breakers where stage = 'draft'")).rows[0]?.probe_at ?? null;
    const q = fakeQueue();
    const second = await parkUnknown(q); // both rows are parked before the breaker opens (it would hold new rows)
    const refused = await parkRefused(q, false);
    for (let n = 0; n < 5; n++) await recordBreakerEvent(db.pool, "draft", "failure");
    await db.ownerPool.query("update breakers set opened_at = clock_timestamp() - interval '1 day' where stage = 'draft'");
    // a refused choice leaves the probe free
    expect(await resolveDecision(db.pool, q, { stageRunId: refused.stageId, choice: "raise_cap_and_rerun", actor: SESSION, raiseCap: { scope: "nope", capMicroUsd: 5_000_000 } })).toMatchObject({ ok: false });
    expect(await probe()).toBeNull();
    // a real rerun takes it
    expect(await resolveDecision(db.pool, q, { stageRunId: refused.stageId, choice: "raise_cap_and_rerun", actor: SESSION, raiseCap: { scope: "g", capMicroUsd: 5_000_000 } })).toMatchObject({ ok: true });
    expect(await probe()).not.toBeNull();
    // with the probe already out, a second rerun is held but a money-only settle still works
    expect(await resolveDecision(db.pool, q, { stageRunId: second.stageId, choice: "release_and_rerun", actor: SESSION })).toMatchObject({ ok: true, rerunHeld: true });
    expect(await stagesOf(second.videoId)).toMatchObject([{ status: "failed" }]);
  });

  it("cancel_video_closes_a_row_with_no_open_money_and_never_overwrites_a_terminal_video", async () => {
    const q = fakeQueue();
    const a = await parkRefused(q, false);
    expect(await resolveDecision(db.pool, q, { stageRunId: a.stageId, choice: "cancel_video", actor: SESSION })).toMatchObject({ ok: true });
    expect((await getStage(db.pool, a.stageId))!.status).toBe("cancelled");
    expect((await db.pool.query("select status from videos where id = $1", [a.videoId])).rows[0].status).toBe("cancelled");
    expect(await resolveDecision(db.pool, q, { stageRunId: a.stageId, choice: "cancel_video", actor: SESSION })).toMatchObject({ ok: false }); // already closed: clean refusal
    expect(await auditRows()).toHaveLength(1);

    for (const terminal of ["failed", "done"]) {
      const b = await parkRefused(q, false);
      await db.ownerPool.query("update videos set status = $2 where id = $1", [b.videoId, terminal]);
      expect(await resolveDecision(db.pool, q, { stageRunId: b.stageId, choice: "cancel_video", actor: SESSION })).toMatchObject({ ok: true });
      expect((await db.pool.query("select status from videos where id = $1", [b.videoId])).rows[0].status).toBe(terminal);
      expect((await getStage(db.pool, b.stageId))!.status).toBe("cancelled");
    }
  });

  it("a_second_cancel_with_money_still_held_is_a_clean_no_op", async () => {
    const q = fakeQueue();
    const { videoId, stageId } = await parkUnknown(q);
    expect(await resolveDecision(db.pool, q, { stageRunId: stageId, choice: "cancel_video", actor: SESSION })).toMatchObject({ ok: true });
    expect(await resolveDecision(db.pool, q, { stageRunId: stageId, choice: "cancel_video", actor: SESSION })).toMatchObject({ ok: true });
    expect(await auditRows()).toHaveLength(1);
    expect((await db.pool.query("select status from videos where id = $1", [videoId])).rows[0].status).toBe("cancelled");
    expect(await g()).toMatchObject({ reservedMicroUsd: RESERVE });
  });

  it("settled_late_and_budget_refused_rows_on_a_cancelled_video_can_still_be_closed", async () => {
    const q = fakeQueue();
    const late = await parkUnknown(q);
    const [i] = await intentsOf(late.stageId);
    await settleIntent(db.pool, i.id, { actualMicroUsd: 5, result: null });
    const refused = await parkRefused(q, false);
    for (const x of [late, refused]) {
      // the video was cancelled by another path (cancelVideo flags rows but leaves parked ones)
      await db.ownerPool.query("update videos set status = 'cancelled' where id = $1", [x.videoId]);
      await db.ownerPool.query("update stage_runs set cancel_requested = true where id = $1", [x.stageId]);
      expect(await resolveDecision(db.pool, q, { stageRunId: x.stageId, choice: "cancel_video", actor: SESSION })).toMatchObject({ ok: true });
      expect((await getStage(db.pool, x.stageId))!.status).toBe("cancelled");
    }
  });

  it("raise_cap_must_name_the_budget_that_was_used_and_stay_within_the_limit", async () => {
    const q = fakeQueue();
    await db.pool.query("insert into budgets (scope, cap_micro_usd) values ('other', 1000)");
    const { stageId } = await parkRefused(q, true); // call 0 used scope g
    const raise = (scope: string, capMicroUsd: number) => resolveDecision(db.pool, q, { stageRunId: stageId, choice: "raise_cap_and_rerun", actor: SESSION, raiseCap: { scope, capMicroUsd } });
    expect(await raise("other", 5000)).toMatchObject({ ok: false, reason: expect.stringMatching(/did not/i) });
    expect(await raise("g", 10_000_001)).toMatchObject({ ok: false, reason: expect.stringMatching(/too high/i) });
    expect((await g()).capMicroUsd).toBe(100);
    expect((await getBudget(db.pool, "other"))!.capMicroUsd).toBe(1000);
    expect(await auditRows()).toHaveLength(0);
    expect(await raise("g", 10_000_000)).toMatchObject({ ok: true });
  });

  it("raise_cap_with_a_changed_input_hash_starts_a_new_row_instead_of_replaying_the_old_one", async () => {
    const q = fakeQueue();
    const { videoId, stageId } = await parkRefused(q, false);
    await db.ownerPool.query("update videos set topic = 'A different topic' where id = $1", [videoId]);
    const r = await resolveDecision(db.pool, q, { stageRunId: stageId, choice: "raise_cap_and_rerun", actor: SESSION, raiseCap: { scope: "g", capMicroUsd: 5_000_000 } });
    expect(r).toMatchObject({ ok: true, newStageRunId: expect.any(String) });
    const rows = await stagesOf(videoId);
    expect(rows.map((x) => x.status)).toEqual(["failed", "queued"]);
    expect(rows[1]!.input_hash).not.toBe(rows[0]!.input_hash);
    expect(q.calls.map((c) => c.id)).toEqual([rows[1]!.id]);
    expect((await auditRows())[0].detail).toMatchObject({ mode: "new_row" });
  });

  it("a_late_settle_racing_the_decision_never_counts_money_twice", async () => {
    // (a) the late settle wins: the choice is re-evaluated under the lock and the unknown call is gone
    const q = fakeQueue();
    const a = await parkUnknown(q);
    const [ia] = await intentsOf(a.stageId);
    await settleIntent(db.pool, ia.id, { actualMicroUsd: 300_000, result: { late: true } });
    expect(await resolveDecision(db.pool, q, { stageRunId: a.stageId, choice: "release_and_rerun", actor: SESSION })).toMatchObject({ ok: false });
    expect(await g()).toMatchObject({ reservedMicroUsd: 0, spentMicroUsd: 300_000 });

    // (b) the owner counts it first: a zombie settle with other numbers is refused, the money stays counted once
    const b = await parkUnknown(q);
    const [ib] = await intentsOf(b.stageId);
    await resolveDecision(db.pool, q, { stageRunId: b.stageId, choice: "keep_spent_and_rerun", actor: SESSION });
    await expect(settleIntent(db.pool, ib.id, { actualMicroUsd: 1, result: { late: true } })).rejects.toThrow(/different values/);
    expect(await g()).toMatchObject({ reservedMicroUsd: 0, spentMicroUsd: 300_000 + RESERVE });

    // (c) the owner released it first: a zombie settle cannot slip money in afterwards
    const c = await parkUnknown(q);
    const [ic] = await intentsOf(c.stageId);
    await resolveDecision(db.pool, q, { stageRunId: c.stageId, choice: "release_and_rerun", actor: SESSION });
    await expect(settleIntent(db.pool, ic.id, { actualMicroUsd: RESERVE, result: null })).rejects.toThrow(/cannot be settled/);
    expect(await g()).toMatchObject({ reservedMicroUsd: 0, spentMicroUsd: 300_000 + RESERVE });
  });
});
