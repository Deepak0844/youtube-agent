import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { canonicalJson, sha256Hex } from "@/server/core/content-hash";
import { stageInputHash } from "@/server/core/pipeline-plan";
import { addContent } from "@/server/db/videos";
import { versionsKey } from "@/server/core/queue-input";
import { approvalReaders } from "@/server/db/approval-readers";
import { liveGateHash } from "@/server/db/approvals";
import { getDecision } from "@/server/db/decision";
import { latestEventId, listEventsSince } from "@/server/db/events";
import { advanceVideo, readNextAction } from "@/server/db/pipeline";
import { cancelVideoById, decideGate, sendUploadAgain, type Queues } from "@/server/db/queue-actions";
import { createEventBus } from "@/server/queue/event-bus";
import { createEventStream } from "@/server/queue/event-stream";
import { withTestDb, type TestDb } from "../support/db";
import {
  counts, killAllEngineWorkers, openWorld, ownerStep, prepareEngineTables, runToUploaded, supervise, uploadStatus, violations, waitUntil, dump,
  type World,
} from "../support/engine-harness";

// Task 25, the Phase 2 exit proof. Real worker processes (the real runtime, dry-run handlers on fake providers), the real
// approval readers and the same owner functions the /queue page calls. Provider calls are counted in tables the product
// does not write: fake_provider_calls (by the real call key) and engine_calls (by logical step).
//
// Every scenario ends with violations(): at most one provider call per call key and per logical step, at most one start per
// upload, each stage once per input, and the money tables equal to the sum of the intents.

let db: TestDb;
let w: World;
beforeAll(async () => {
  db = await withTestDb();
  await prepareEngineTables(db);
}, 180_000);
beforeEach(async () => {
  await db.reset();
  w = await openWorld(db);
});
afterEach(async () => {
  await w?.close();
  await killAllEngineWorkers();
});
afterAll(async () => {
  await db?.stop();
});

const N_LOAD = Number(process.env.ENGINE_LOAD_N ?? 30);
const STAGES = ["draft", "build", "generate", "tts", "render", "voice", "sfx", "qa"];
const GATES = ["script", "cost", "video", "evidence", "publish"];
const q = (sql: string, args: unknown[] = []) => db.pool.query(sql, args);

/** How many paid calls one undisturbed run makes: one per planned image, plus the narration. */
async function plannedCalls(videoId: string): Promise<number> {
  const plan = (await q("select body from video_content where video_id = $1 and kind = 'cost_plan' order by version desc limit 1", [videoId])).rows[0]?.body as { items: unknown[] };
  return plan.items.length + 1;
}
const stageRow = async (videoId: string, name: string) => (await q("select id, status, fence, input_hash from stage_runs where video_id = $1 and name = $2 order by created_at desc limit 1", [videoId, name])).rows[0] as { id: string; status: string; fence: string; input_hash: string } | undefined;
const callsFor = async (videoId: string) => (await q("select count(*)::int n from engine_calls e join spend_intents i on i.call_key = e.real_key join stage_runs s on s.id = i.stage_run_id where s.video_id = $1", [videoId])).rows[0].n as number;
const callsAt = async (videoId: string, stage: string) => (await q("select count(*)::int n from engine_calls e join spend_intents i on i.call_key = e.real_key join stage_runs s on s.id = i.stage_run_id where s.video_id = $1 and s.name = $2", [videoId, stage])).rows[0].n as number;

/** The reference run every disturbed run is compared with. */
async function expectFinished(videoId: string, planned: number) {
  expect(await uploadStatus(db.pool, videoId)).toBe("uploaded");
  expect((await q("select count(*)::int n from uploads where video_id = $1", [videoId])).rows[0].n).toBe(1);
  expect(await readNextAction(db.pool, videoId, approvalReaders)).toMatchObject({ kind: "done" });
  expect(await violations(db.pool)).toEqual([]);
  expect(planned).toBeGreaterThan(1);
}

describe("happy path", () => {
  it("a_fake_video_goes_through_every_stage_and_gate_and_uploads_once", async () => {
    const worker = w.spawnWorker();
    await worker.ready();
    const videoId = await w.newVideo();
    const actions = await runToUploaded(w, videoId);
    await worker.stop();

    expect(actions.filter((a) => a.kind === "gate").map((a) => (a as { gate: string }).gate)).toEqual(GATES);
    expect(actions.every((a) => (a as { ok: boolean }).ok)).toBe(true);
    const c = await counts(db.pool, videoId);
    expect(c.stageRuns).toEqual(Object.fromEntries(STAGES.map((s) => [s, 1])));
    expect((await q("select status from stage_runs where video_id = $1", [videoId])).rows.every((r) => r.status === "succeeded")).toBe(true);
    const planned = await plannedCalls(videoId);
    expect(c.providerCalls).toBe(planned);
    expect((await q("select count(*)::int n from fake_provider_calls where call_key not like 'fake:upload:%'")).rows[0].n).toBe(planned);
    await expectFinished(videoId, planned);
    // the money: the day cap's spent figure equals the settled intents, nothing is still reserved
    const day = (await q("select spent_micro_usd s, reserved_micro_usd r from budgets where scope like 'day:%'")).rows[0];
    expect({ spent: Number(day.s), reserved: Number(day.r) }).toEqual({ spent: c.settledMicroUsd, reserved: 0 });
  }, 240_000);
});

describe("crash: SIGKILL at the five points", () => {
  // (a) before the call is reserved, (d) after settle before commit, (e) after commit before the worker moves on:
  // the restart finishes with zero repeat calls (finished calls are replayed from the intents table).
  for (const [point, stage, nth, label] of [
    ["a", "generate", 0, "before_a_provider_call"],
    ["d", "generate", 0, "after_settle_before_commit"],
    ["e", "generate", 0, "after_commit_before_advance"],
  ] as const) {
    it(`crash_${label}_resumes_with_zero_repeat_calls`, async () => {
      const sup = supervise(w, { crash: { stage, point, nth } });
      await sup.current().ready();
      const videoId = await w.newVideo();
      await runToUploaded(w, videoId);
      await sup.stop();
      expect(sup.crashes()).toBe(1); // it really died, once
      const planned = await plannedCalls(videoId);
      expect(await callsFor(videoId)).toBe(planned); // exactly the planned calls: nothing repeated
      expect((await counts(db.pool, videoId)).stageRuns).toEqual(Object.fromEntries(STAGES.map((s) => [s, 1])));
      await expectFinished(videoId, planned);
    }, 240_000);
  }

  // (b) the provider was called, nothing came back; (c) it came back, settle never ran. Nobody knows if money was spent:
  // the stage parks, shows the reservation, and only the owner moves it on.
  for (const [point, choice, label] of [
    ["b", "release_and_rerun", "during_a_provider_call"],
    ["c", "keep_spent_and_rerun", "after_the_provider_returned_before_settle"],
  ] as const) {
    it(`crash_${label}_parks_with_the_reservation_then_the_owner_resolves_it`, async () => {
      const sup = supervise(w, { crash: { stage: "tts", point, nth: 0 } });
      await sup.current().ready();
      const videoId = await w.newVideo();
      await runToUploaded(w, videoId, { parked: "none", until: async () => (await stageRow(videoId, "tts"))?.status === "needs_decision" });
      expect(sup.crashes()).toBe(1);
      const parked = (await stageRow(videoId, "tts"))!;
      const d = await getDecision(db.pool, parked.id);
      expect(d).toMatchObject({ reason: "paid_call_may_have_run", maxCostMicroUsd: 1000 }); // the dollar figure is the reservation of the one line in flight
      const callsAtPark = await callsFor(videoId);
      await new Promise((r) => setTimeout(r, 1500)); // the reconciler keeps running; it must leave the parked stage alone
      expect(await callsFor(videoId)).toBe(callsAtPark);
      expect((await stageRow(videoId, "tts"))!.status).toBe("needs_decision");

      const taken = await runToUploaded(w, videoId, { parked: choice });
      await sup.stop();
      expect(taken.filter((t) => t.kind === "parked")).toMatchObject([{ choice, ok: true }]);
      // the old call key reached the provider once; the owner's rerun is a NEW stage row with new keys
      const planned = await plannedCalls(videoId);
      expect(await callsAt(videoId, "tts")).toBe(2);
      expect(await callsFor(videoId)).toBe(planned + 1);
      expect((await q("select count(*)::int n from stage_runs where video_id = $1 and name = 'tts'", [videoId])).rows[0].n).toBe(2);
      const old = (await q("select status, actual_micro_usd from spend_intents where stage_run_id = $1", [parked.id])).rows;
      expect(old.length).toBe(1);
      expect(old[0].status).toBe(choice === "release_and_rerun" ? "failed_known" : "done");
      await expectFinished(videoId, planned);
    }, 240_000);
  }
});

describe("stall", () => {
  it("lease_expiring_during_a_paid_call_records_the_money_once_discards_the_result_and_never_calls_twice", async () => {
    w.setPlan({ hang: { stage: "tts", ms: 5000 } });
    const worker = w.spawnWorker();
    await worker.ready();
    const videoId = await w.newVideo();
    await runToUploaded(w, videoId, { until: async () => (await callsAt(videoId, "tts")) === 1 });
    const stuck = (await stageRow(videoId, "tts"))!;
    expect(stuck.status).toBe("running");
    await q("update stage_runs set lease_until = clock_timestamp() - interval '1 second' where id = $1", [stuck.id]);
    // the reconciler parks it (an open paid call), then the provider finally answers
    await waitUntil(async () => (await stageRow(videoId, "tts"))!.status === "needs_decision", "stalled stage parked", 20_000);
    await waitUntil(async () => (await q("select status from spend_intents where stage_run_id = $1", [stuck.id])).rows[0]?.status === "done", "late settle recorded", 20_000);
    await new Promise((r) => setTimeout(r, 1000));

    expect(await callsAt(videoId, "tts")).toBe(1); // no second call
    expect((await stageRow(videoId, "tts"))!.status).toBe("needs_decision"); // not committed, not retried
    expect((await q("select count(*)::int n from video_content where video_id = $1 and kind = 'narration'", [videoId])).rows[0].n).toBe(0);
    const dir = path.join(w.root, "videos", videoId);
    expect(readdirSync(dir).filter((f) => f.endsWith(".wav"))).toEqual([]); // nothing promoted
    const tts = (await q("select status, actual_micro_usd a from spend_intents where stage_run_id = $1", [stuck.id])).rows;
    expect(tts).toEqual([{ status: "done", a: "1000" }]); // the fake voice charged 1000 micro-USD, recorded once
    expect(Number((await q("select reserved_micro_usd r from budgets where scope like 'day:%'")).rows[0].r)).toBe(0);
    const d = await getDecision(db.pool, stuck.id);
    expect(d).toMatchObject({ reason: "settled_late", maxCostMicroUsd: 0 });

    w.setPlan({});
    await runToUploaded(w, videoId, { parked: "use_result" });
    await worker.stop();
    const planned = await plannedCalls(videoId);
    expect(await callsFor(videoId)).toBe(planned); // using the stored result paid for nothing again
    await expectFinished(videoId, planned);
  }, 240_000);
});

describe("duplicate delivery", () => {
  it("the_same_stage_job_and_upload_job_delivered_many_times_to_two_workers_run_once", async () => {
    const videoId = await w.newVideo();
    await advanceVideo(db.pool, w.queues.stage, videoId, approvalReaders);
    const draft = (await q("select id, input_hash from stage_runs where video_id = $1", [videoId])).rows[0];
    for (const fence of [1, 2, 3]) await w.queues.stage.enqueue(draft.id, fence, 0, draft.input_hash); // same stage, other job ids
    const [a, b] = [w.spawnWorker("wa"), w.spawnWorker("wb")];
    await Promise.all([a.ready(), b.ready()]);

    // hammer the upload door as soon as the row exists: re-enqueue and "send again" concurrently
    let stopHammer = false;
    const hammer = (async () => {
      while (!stopHammer) {
        const u = (await q("select id from uploads limit 1")).rows[0];
        if (u) {
          await Promise.allSettled([1, 2, 3, 4].map(() => w.queues.uploadQueue.enqueueUpload(u.id)));
          await Promise.allSettled([1, 2, 3].map(() => sendUploadAgain(db.pool, w.queues, w.session, u.id)));
          return;
        }
        await new Promise((r) => setTimeout(r, 20));
      }
    })();
    await runToUploaded(w, videoId);
    stopHammer = true;
    await hammer;
    await Promise.all([a.stop(), b.stop()]);

    const rows = (await q("select name, fence from stage_runs where video_id = $1", [videoId])).rows;
    expect(rows.map((r) => r.name).sort()).toEqual([...STAGES].sort());
    expect(rows.every((r) => Number(r.fence) === 1)).toBe(true); // each stage was claimed exactly once
    const up = (await q("select id, attempt from uploads where video_id = $1", [videoId])).rows;
    expect(up).toHaveLength(1);
    expect(up[0].attempt).toBe(1);
    expect((await q("select count(*)::int n from fake_provider_calls where call_key = $1", [`fake:upload:${up[0].id}`])).rows[0].n).toBe(1);
    await expectFinished(videoId, await plannedCalls(videoId));
  }, 240_000);
});

describe("redis wipe", () => {
  it("i_queued_rows_survive_a_flush_and_run_once", async () => {
    const videoId = await w.newVideo();
    await advanceVideo(db.pool, w.queues.stage, videoId, approvalReaders); // row queued, job in Redis
    await w.flushRedis(); // job gone
    const worker = w.spawnWorker();
    await worker.ready();
    await runToUploaded(w, videoId);
    await worker.stop();
    expect((await counts(db.pool, videoId)).stageRuns).toEqual(Object.fromEntries(STAGES.map((s) => [s, 1])));
    await expectFinished(videoId, await plannedCalls(videoId));
  }, 240_000);

  it("ii_a_flush_in_the_middle_of_a_run_loses_nothing_and_repeats_nothing", async () => {
    w.setPlan({ hang: { stage: "generate", ms: 1500, nth: 1 } });
    const worker = w.spawnWorker();
    await worker.ready();
    const videoId = await w.newVideo();
    await runToUploaded(w, videoId, { until: async () => (await callsAt(videoId, "generate")) === 2 }); // inside a paid call
    await w.flushRedis();
    w.setPlan({});
    await runToUploaded(w, videoId);
    await worker.stop();
    expect((await counts(db.pool, videoId)).stageRuns).toEqual(Object.fromEntries(STAGES.map((s) => [s, 1])));
    await expectFinished(videoId, await plannedCalls(videoId));
  }, 240_000);

  it("iii_a_video_parked_at_a_gate_survives_a_flush_and_an_approval_during_the_outage_still_advances_it", async () => {
    const worker = w.spawnWorker();
    await worker.ready();
    const videoId = await w.newVideo();
    await runToUploaded(w, videoId, { skipGates: ["cost"], until: async () => (await readNextAction(db.pool, videoId, approvalReaders))?.kind === "wait_gate" && (await readNextAction(db.pool, videoId, approvalReaders) as { gate: string }).gate === "cost" });
    await w.flushRedis();
    // The owner approves while the queue is unreachable: the approval is recorded, the enqueue fails, the worker's sweep carries on.
    const down: Queues = {
      stage: { enqueue: async () => { throw new Error("redis is down"); } },
      upload: { enqueueUpload: async () => { throw new Error("redis is down"); } },
    };
    const live = (await liveGateHash(db.pool, videoId, "cost"))!;
    const r = await decideGate(db.pool, down, w.session, { videoId, gate: "cost", seenHash: live.hash, seenVersions: versionsKey(live.versions), note: undefined }, "approve", { root: w.root });
    expect(r.ok).toBe(true);
    await runToUploaded(w, videoId);
    await worker.stop();
    expect((await counts(db.pool, videoId)).stageRuns).toEqual(Object.fromEntries(STAGES.map((s) => [s, 1])));
    await expectFinished(videoId, await plannedCalls(videoId));
  }, 240_000);

  it("iv_a_live_feed_client_reconnects_with_its_last_id_and_sees_no_gap_and_no_duplicate", async () => {
    const bus = createEventBus(db.redisUrl);
    const seen: number[][] = [[], []];
    const open = (startId: number, into: number[]) => {
      const ac = new AbortController();
      const stream = createEventStream({
        startId, signal: ac.signal, pollMs: 300,
        fetchSince: (after, limit) => listEventsSince(db.pool, after, limit),
        subscribe: (wake) => bus.subscribe(wake),
      });
      const reader = stream.getReader();
      const dec = new TextDecoder();
      const done = (async () => {
        for (;;) {
          const { value, done: end } = await reader.read().catch(() => ({ value: undefined, done: true }));
          if (end) return;
          for (const m of dec.decode(value).matchAll(/^id: (\d+)$/gm)) into.push(Number(m[1]));
        }
      })();
      return { close: async () => { ac.abort(); await done; } };
    };
    try {
      const worker = w.spawnWorker();
      await worker.ready();
      const videoId = await w.newVideo();
      const first = open(await latestEventId(db.pool), seen[0]!);
      await runToUploaded(w, videoId, { until: async () => seen[0]!.length >= 6 });
      await w.flushRedis(); // the wake-up channel is wiped under a connected client
      await runToUploaded(w, videoId, { until: async () => seen[0]!.length >= 12 });
      await first.close(); // the tab goes away
      const last = seen[0]!.at(-1)!;
      await w.flushRedis();
      await runToUploaded(w, videoId, { until: async () => (await uploadStatus(db.pool, videoId)) === "uploaded" }).catch(() => undefined);
      await runToUploaded(w, videoId);
      const second = open(last, seen[1]!); // reconnect with Last-Event-ID
      const all = (await q("select id from events order by id")).rows.map((r) => Number(r.id));
      await waitUntil(() => seen[1]!.length >= all.filter((i) => i > last).length, "second client caught up", 20_000);
      await second.close();
      await worker.stop();
      const got = [...seen[0]!, ...seen[1]!];
      expect(got).toEqual(all); // no gap, no duplicate, in order
      expect(seen[0]!.length).toBeGreaterThanOrEqual(12);
      expect(await violations(db.pool)).toEqual([]);
    } finally {
      await bus.close();
    }
  }, 240_000);
});

describe("cancel", () => {
  it("cancel_in_the_middle_of_a_stage_makes_no_new_paid_call_afterwards", async () => {
    w.setPlan({ hang: { stage: "generate", ms: 3000, nth: 0 } });
    const worker = w.spawnWorker();
    await worker.ready();
    const videoId = await w.newVideo();
    await runToUploaded(w, videoId, { until: async () => (await callsAt(videoId, "generate")) === 1 });
    const r = await cancelVideoById(db.pool, w.session, videoId);
    expect(r.ok).toBe(true);
    await new Promise((res) => setTimeout(res, 5000)); // the hung call returns; the engine must not buy the next image
    await waitUntil(async () => (await q("select count(*)::int n from stage_runs where video_id = $1 and status in ('queued','running')", [videoId])).rows[0].n === 0, "nothing left running", 20_000).catch(async (e) => { throw new Error(`${e.message}\n${await dump(db.pool, videoId)}\n${JSON.stringify((await q("select name, status, cancel_requested, result from stage_runs where video_id = $1", [videoId])).rows)}`); });
    expect(await callsFor(videoId)).toBe(1);
    expect((await q("select status from videos where id = $1", [videoId])).rows[0].status).toBe("cancelled");
    expect((await q("select count(*)::int n from stage_runs where video_id = $1 and name in ('tts','render')", [videoId])).rows[0].n).toBe(0);
    await worker.stop();
    expect(await violations(db.pool)).toEqual([]);
  }, 240_000);
});

describe("approval races", () => {
  const input = async (videoId: string, gate: "script" | "cost") => {
    const live = (await liveGateHash(db.pool, videoId, gate))!;
    return { videoId, gate, seenHash: live.hash, seenVersions: versionsKey(live.versions), note: undefined as string | undefined };
  };
  const atScript = async (videoId: string) => {
    await runToUploaded(w, videoId, { skipGates: ["script"], until: async () => { const n = await readNextAction(db.pool, videoId, approvalReaders); return n?.kind === "wait_gate" && n.gate === "script"; } });
  };

  it("approving_twice_at_once_builds_once", async () => {
    const worker = w.spawnWorker();
    await worker.ready();
    const videoId = await w.newVideo();
    await atScript(videoId);
    const i = await input(videoId, "script");
    const [x, y] = await Promise.all([decideGate(db.pool, w.queues, w.session, i, "approve"), decideGate(db.pool, w.queues, w.session, i, "approve")]);
    expect([x.ok, y.ok].filter(Boolean).length).toBeGreaterThanOrEqual(1);
    await runToUploaded(w, videoId);
    await worker.stop();
    expect((await counts(db.pool, videoId)).stageRuns.build).toBe(1);
    await expectFinished(videoId, await plannedCalls(videoId));
  }, 240_000);

  it("approve_after_send_back_with_the_old_hash_is_refused_and_the_rewrite_needs_a_fresh_approval", async () => {
    const worker = w.spawnWorker();
    await worker.ready();
    const videoId = await w.newVideo();
    await atScript(videoId);
    const old = await input(videoId, "script");
    const sb = await decideGate(db.pool, w.queues, w.session, { ...old, note: "Make the opening punchier please" }, "send_back");
    expect(sb.ok).toBe(true);
    // the worker rewrites the draft; wait for the new script, then approve with the STALE view
    // (the scripted fake model writes the same words again, so the hash may repeat; the saved VERSION is new and the view is stale)
    await waitUntil(async () => { const n = await readNextAction(db.pool, videoId, approvalReaders); const live = await liveGateHash(db.pool, videoId, "script"); return n?.kind === "wait_gate" && live && versionsKey(live.versions) !== old.seenVersions; }, "rewritten script waiting", 30_000);
    const stale = await decideGate(db.pool, w.queues, w.session, old, "approve");
    expect(stale).toMatchObject({ ok: false, message: "This changed while you were looking. Review again." });
    expect((await q("select count(*)::int n from approvals where video_id = $1 and gate = 'script' and decision = 'approved'", [videoId])).rows[0].n).toBe(0);
    expect((await counts(db.pool, videoId)).stageRuns.build).toBeUndefined();
    // The engine also refuses to approve text identical to what was sent back; the real rewrite is different (here: one word changed).
    const same = await decideGate(db.pool, w.queues, w.session, await input(videoId, "script"), "approve");
    expect(same.ok).toBe(false);
    const cur = (await q("select body from video_content where video_id = $1 and kind = 'script' order by version desc limit 1", [videoId])).rows[0].body as { narration: string };
    const body = { ...cur, narration: cur.narration.replace(/^\S+/, "Rewritten") };
    await addContent(db.pool, videoId, "script", { body, sha256: sha256Hex(canonicalJson(body)) });
    const beats = { beats: [{ id: "b1", text: body.narration }] };
    await addContent(db.pool, videoId, "beats", { body: beats, sha256: sha256Hex(canonicalJson(beats)) });
    await runToUploaded(w, videoId);
    await worker.stop();
    expect((await counts(db.pool, videoId)).stageRuns.draft).toBe(2);
    await expectFinished(videoId, await plannedCalls(videoId));
  }, 240_000);

  it("approve_racing_a_send_back_exactly_one_wins_and_build_never_runs_on_unapproved_text", async () => {
    const worker = w.spawnWorker();
    await worker.ready();
    const videoId = await w.newVideo();
    await atScript(videoId);
    const i = await input(videoId, "script");
    const initialDraft = await stageRow(videoId, "draft");
    const initialScriptSha = (await q("select sha256 from video_content where video_id = $1 and kind = 'script' order by version desc limit 1", [videoId])).rows[0].sha256 as string;
    const [ap, sb] = await Promise.all([
      decideGate(db.pool, w.queues, w.session, i, "approve"),
      decideGate(db.pool, w.queues, w.session, { ...i, note: "Shorter hook, please" }, "send_back"),
    ]);
    const allowedBuildInputs = new Set<string>();
    if (ap.ok) allowedBuildInputs.add(stageInputHash("build", { prev: initialDraft!.input_hash, script: initialScriptSha }, {}));
    // approve and send-back can both be recorded (approve first, then the owner sends it back); what must hold is that the
    // text build used is the text that was approved at the moment it started.
    expect(ap.ok || sb.ok).toBe(true);
    if (sb.ok) {
      // The dry-run LLM is deterministic and rewrites the same words. Model a real accepted rewrite so the
      // unchanged-content guard does not (correctly) leave this race parked at the script gate forever.
      await waitUntil(async () => {
        const next = await readNextAction(db.pool, videoId, approvalReaders);
        return next?.kind === "wait_gate" && next.gate === "script" && (await counts(db.pool, videoId)).stageRuns.draft === 2;
      }, "send-back rewrite", 30_000);
      const cur = (await q("select body from video_content where video_id = $1 and kind = 'script' order by version desc limit 1", [videoId])).rows[0].body as { narration: string };
      const body = { ...cur, narration: cur.narration.replace(/^\S+/, "Rewritten") };
      await addContent(db.pool, videoId, "script", { body, sha256: sha256Hex(canonicalJson(body)) });
      const beats = { beats: [{ id: "b1", text: body.narration }] };
      await addContent(db.pool, videoId, "beats", { body: beats, sha256: sha256Hex(canonicalJson(beats)) });
      const rewrittenDraft = await stageRow(videoId, "draft");
      allowedBuildInputs.add(stageInputHash("build", { prev: rewrittenDraft!.input_hash, script: sha256Hex(canonicalJson(body)) }, {}));
    }
    await runToUploaded(w, videoId);
    await worker.stop();
    const builds = (await q("select input_hash from stage_runs where video_id = $1 and name = 'build' order by created_at", [videoId])).rows as Array<{ input_hash: string }>;
    expect(builds.length).toBeGreaterThanOrEqual(1);
    expect(builds.every((build) => allowedBuildInputs.has(build.input_hash))).toBe(true);
    const approvedHashes = new Set((await q("select content_hash from approvals where video_id = $1 and gate = 'script' and decision = 'approved'", [videoId])).rows.map((r) => r.content_hash));
    const finalScript = (await liveGateHash(db.pool, videoId, "script"))!.hash;
    expect(approvedHashes.has(finalScript)).toBe(true); // the script that shipped was approved as shipped
    await expectFinished(videoId, await plannedCalls(videoId));
  }, 240_000);
});

describe("load", () => {
  it("thirty_queued_fake_videos_finish_on_two_workers_under_the_daily_cap", async () => {
    const [a, b] = [w.spawnWorker("la"), w.spawnWorker("lb")];
    await Promise.all([a.ready(), b.ready()]);
    const ids: string[] = [];
    for (let i = 0; i < N_LOAD; i++) ids.push(await w.newVideo(`Fake topic number ${i + 1}`));
    const deadline = Date.now() + 420_000;
    let lastLog = 0;
    for (;;) {
      if (process.env.ENGINE_DEBUG && Date.now() - lastLog > 10_000) { lastLog = Date.now(); console.error("progress", JSON.stringify((await q("select name, status, count(*)::int n from stage_runs group by 1,2 order by 1,2")).rows.filter((r) => r.status !== "succeeded")), JSON.stringify((await q("select status, count(*)::int n from uploads group by 1")).rows)); }
      const pending = (await q("select v.id from videos v where not exists (select 1 from uploads u where u.video_id = v.id)")).rows.map((r) => r.id as string);
      if (pending.length === 0) break;
      if (Date.now() > deadline) throw new Error(`${pending.length} of ${N_LOAD} videos unfinished\n${await dump(db.pool, pending[0]!)}`);
      const steps = [];
      for (const id of pending) steps.push(await ownerStep(w, id));
      if (process.env.ENGINE_DEBUG) for (const st of steps) if (st.kind === "gate" && !st.ok) console.error("owner", JSON.stringify(st));
      await new Promise((r) => setTimeout(r, 250));
    }
    await waitUntil(async () => (await q("select count(*)::int n from uploads where status = 'uploaded'")).rows[0].n === Math.min(N_LOAD, 6), "daily upload cap reached", 30_000);
    await Promise.all([a.stop(), b.stop()]);
    expect((await q("select count(*)::int n from stage_runs where status <> 'succeeded'")).rows[0].n).toBe(0);
    expect((await q("select count(*)::int n from stage_runs")).rows[0].n).toBe(N_LOAD * STAGES.length);
    // The uploader's own daily cap (6 uploads a day, publish-rules UPLOAD_CAPS) holds the rest at publish_approved by design.
    expect((await q("select count(*)::int n from uploads where status = 'publish_approved'")).rows[0].n).toBe(Math.max(0, N_LOAD - 6));
    const day = (await q("select spent_micro_usd s, cap_micro_usd c from budgets where scope like 'day:%'")).rows[0];
    expect(Number(day.s)).toBeLessThanOrEqual(Number(day.c));
    expect(await violations(db.pool)).toEqual([]);
    void existsSync;
  }, 480_000);
});
