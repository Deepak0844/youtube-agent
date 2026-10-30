import { mkdtempSync, readdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { saveImage } from "@/server/providers/image";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildEngineConfig } from "@/server/core/engine-config";
import type { StageHandler } from "@/server/core/stage-handler";
import type { StageRunnerDeps } from "@/server/core/stage-runner";
import { getDecision, resolveDecision } from "@/server/db/decision";
import { checkParkedJob } from "@/server/db/job-check";
import { advanceVideo } from "@/server/db/pipeline";
import { reconcile } from "@/server/db/reconciler";
import { getBudget } from "@/server/db/spend";
import { runStage } from "@/server/db/stage-runner-adapter";
import { getStage } from "@/server/db/stages";
import { createVideoRow } from "@/server/db/videos";
import type { JobChecker, JobOutcome, MediaArtifact } from "@/server/providers/media-types";
import { withTestDb, type TestDb } from "../support/db";

let db: TestDb;
beforeAll(async () => { db = await withTestDb(); });
afterAll(async () => { await db?.stop(); });
beforeEach(async () => {
  await db.reset();
  await db.pool.query("insert into budgets (scope, cap_micro_usd) values ('g', 100000000)");
  await db.ownerPool.query(
    "insert into sessions (id, token_hash, expires_at, absolute_expires_at) values ($1, 'jc-test', clock_timestamp() + interval '1 day', clock_timestamp() + interval '7 days')",
    [SESSION_ID],
  );
});

const SESSION_ID = "0190f3a2-7c1e-7a55-9d3b-2f6c8a1b4e91";
const SESSION = { kind: "session", sessionId: SESSION_ID } as const;
const input = { format: "short", kind: "scene_kit", language: "en", topic: "Why the sky is blue" } as const;
const RESERVE = 3000;
const JOB_ID = "req-1234abcd";
const ART: MediaArtifact = { path: "/x/generated-media/ab/abc.png", bytes: 67, sha256: "abc", provenance: { provider: "fal_image", model: "m", params: {}, priceMicroUsd: RESERVE, quoted: true } };
const q = { enqueue: async () => "j", liveJobIds: async () => new Set<string>() };

/** Scripted fake fal: counts every call so a test can prove no second submit or extra poll happened. */
function fakeFal(script: Array<JobOutcome | Error>) {
  const f: { polls: number; seen: string[]; checker: JobChecker } = {
    polls: 0,
    seen: [],
    checker: {
      async check(job) {
        f.polls++;
        f.seen.push(job.providerJobId);
        const o = script[Math.min(f.polls - 1, script.length - 1)]!;
        if (o instanceof Error) throw o;
        return o;
      },
    },
  };
  return f;
}

/** A real stage whose fal job was submitted (id stored) and then the worker died: parked by the reconciler. */
async function park(jobState: "submitted" | "unknown" | "submitting" = "submitted") {
  const v = await createVideoRow(db.pool, input);
  await advanceVideo(db.pool, q, v.id);
  const d = (await db.pool.query<{ id: string }>("select id from stage_runs where video_id = $1 and name = 'draft'", [v.id])).rows[0]!;
  const row = (await getStage(db.pool, d.id))!;
  const handler: StageHandler = (ctx) => ctx.paid({ reserveMicroUsd: RESERVE, budgetScopes: ["g"], kind: "paid" }, async () => { throw new Error("socket hang up"); });
  const deps: StageRunnerDeps = { provider: { call: async () => ({}) } as never, ttlMs: 300, workerId: "w", handler, config: buildEngineConfig(new Map()) };
  await expect(runStage(db.pool, deps, { stageRunId: d.id, inputHash: row.inputHash })).rejects.toThrow(/socket hang up/);
  await db.ownerPool.query("update stage_runs set lease_until = clock_timestamp() - interval '1 second' where id = $1", [d.id]);
  expect((await reconcile(db.pool, q, { graceMs: 0 })).needsDecision).toEqual([d.id]);
  await db.ownerPool.query(
    "insert into media_jobs (id, stage_run_id, step, provider, kind, provider_job_id, state, quote_micro_usd) values (gen_random_uuid(), $1, 0, 'fal_image', 'image', $2, $3, $4)",
    [d.id, jobState === "submitting" ? null : JOB_ID, jobState, RESERVE],
  );
  return { stageId: d.id, videoId: v.id };
}
const run = (stageId: string, f: ReturnType<typeof fakeFal>) => checkParkedJob(db.pool, { fal_image: f.checker }, { stageRunId: stageId, actor: SESSION });
const intents = async (id: string) => (await db.pool.query("select status, actual_micro_usd::int as actual, result, provider_ref from spend_intents where stage_run_id = $1", [id])).rows;
const job = async (id: string) => (await db.pool.query("select state, artifact from media_jobs where stage_run_id = $1", [id])).rows[0];
const budget = async () => (await getBudget(db.pool, "g"))!;
const audits = async () => (await db.ownerPool.query("select detail from audit_log where event = 'stage.job_checked' order by id")).rows.map((r) => r.detail);
const stageCount = async (videoId: string) => Number((await db.pool.query("select count(*) from stage_runs where video_id = $1 and name = 'draft'", [videoId])).rows[0].count);

describe("check the job", () => {
  it("done_settles_the_same_reservation_with_the_stored_result_and_offers_use_result", async () => {
    const { stageId, videoId } = await park();
    const view = await getDecision(db.pool, stageId, new Set(["fal_image"]));
    expect(view!.choices[0]).toBe("check_the_job");
    expect(await getDecision(db.pool, stageId)).toMatchObject({ choices: ["release_and_rerun", "keep_spent_and_rerun", "cancel_video"] });
    const f = fakeFal([{ kind: "done", artifact: ART }]);
    expect(await run(stageId, f)).toMatchObject({ ok: true, outcome: "done" });
    expect(f.seen).toEqual([JOB_ID]);
    expect(await intents(stageId)).toMatchObject([{ status: "done", actual: RESERVE, provider_ref: JOB_ID, result: ART }]);
    expect(await budget()).toMatchObject({ reservedMicroUsd: 0, spentMicroUsd: RESERVE });
    expect(await job(stageId)).toMatchObject({ state: "done", artifact: ART });
    expect(await stageCount(videoId)).toBe(1); // no new stage run, no new reservation
    expect(await getDecision(db.pool, stageId)).toMatchObject({ reason: "settled_late", choices: ["use_result", "cancel_video"] });
    expect(await audits()).toEqual([expect.objectContaining({ stageRunId: stageId, jobId: JOB_ID, outcome: "done", sessionId: SESSION_ID })]);
  });

  it("running_stays_parked_and_keeps_the_money_held", async () => {
    const { stageId } = await park();
    const f = fakeFal([{ kind: "running" }]);
    expect(await run(stageId, f)).toMatchObject({ ok: true, outcome: "running" });
    expect(await intents(stageId)).toMatchObject([{ status: "unknown" }]);
    expect(await budget()).toMatchObject({ reservedMicroUsd: RESERVE, spentMicroUsd: 0 });
    expect((await getDecision(db.pool, stageId))!.reason).toBe("paid_call_may_have_run");
    expect((await audits())[0]).toMatchObject({ outcome: "running", jobId: JOB_ID });
  });

  it("failed_keeps_the_reservation_and_leaves_the_existing_choices", async () => {
    const { stageId } = await park();
    expect(await run(stageId, fakeFal([{ kind: "failed", reason: "fal says the job failed" }]))).toMatchObject({ ok: true, outcome: "failed" });
    expect(await budget()).toMatchObject({ reservedMicroUsd: RESERVE });
    expect(await intents(stageId)).toMatchObject([{ status: "unknown" }]);
    expect((await getDecision(db.pool, stageId))!.choices).toContain("release_and_rerun");
    expect((await audits())[0]).toMatchObject({ outcome: "failed" });
  });

  it("unknown_and_thrown_errors_stay_parked_and_never_release", async () => {
    const { stageId } = await park();
    for (const script of [[{ kind: "unknown" }], [new Error("boom")]] as Array<Array<JobOutcome | Error>>) {
      expect(await run(stageId, fakeFal(script))).toMatchObject({ ok: true, outcome: "unknown" });
    }
    expect(await budget()).toMatchObject({ reservedMicroUsd: RESERVE, spentMicroUsd: 0 });
    expect(await intents(stageId)).toMatchObject([{ status: "unknown" }]);
    expect(await audits()).toHaveLength(2);
  });

  it("a_double_click_settles_once", async () => {
    const { stageId } = await park();
    const f = fakeFal([{ kind: "done", artifact: ART }]);
    const [a, b] = await Promise.all([run(stageId, f), run(stageId, f)]);
    expect([a, b].filter((r) => r.ok && r.outcome === "done")).toHaveLength(1);
    expect(await budget()).toMatchObject({ reservedMicroUsd: 0, spentMicroUsd: RESERVE });
    expect(await run(stageId, f)).toMatchObject({ ok: true, outcome: "already_done" });
    expect(await budget()).toMatchObject({ spentMicroUsd: RESERVE });
    expect((await audits()).filter((d) => d.outcome === "done")).toHaveLength(1);
  });

  it("a_failed_attempt_then_a_retry_still_settles_exactly_once", async () => {
    const { stageId } = await park();
    const f = fakeFal([new Error("crash mid-download"), { kind: "done", artifact: ART }]);
    expect(await run(stageId, f)).toMatchObject({ outcome: "unknown" });
    expect(await budget()).toMatchObject({ reservedMicroUsd: RESERVE, spentMicroUsd: 0 });
    expect(await run(stageId, f)).toMatchObject({ outcome: "done" });
    expect(await budget()).toMatchObject({ reservedMicroUsd: 0, spentMicroUsd: RESERVE });
  });

  it("a_job_whose_id_was_never_stored_cannot_be_checked", async () => {
    const { stageId } = await park("submitting");
    const f = fakeFal([{ kind: "done", artifact: ART }]);
    expect(await getDecision(db.pool, stageId, new Set(["fal_image"]))).toMatchObject({ choices: ["release_and_rerun", "keep_spent_and_rerun", "cancel_video"] });
    expect(await run(stageId, f)).toMatchObject({ ok: false });
    expect(f.polls).toBe(0);
  });

  it("a_provider_without_a_checker_and_a_stranger_are_refused_and_poll_nothing", async () => {
    const { stageId } = await park();
    const f = fakeFal([{ kind: "done", artifact: ART }]);
    expect(await checkParkedJob(db.pool, {}, { stageRunId: stageId, actor: SESSION })).toMatchObject({ ok: false });
    expect(await checkParkedJob(db.pool, { fal_image: f.checker }, { stageRunId: stageId, actor: { kind: "token" } as never })).toMatchObject({ ok: false });
    expect(f.polls).toBe(0);
    expect(await budget()).toMatchObject({ reservedMicroUsd: RESERVE });
  });

  it("the_old_resolver_refuses_the_new_choice", async () => {
    const { stageId } = await park();
    expect(await resolveDecision(db.pool, q, { stageRunId: stageId, choice: "check_the_job", actor: SESSION })).toMatchObject({ ok: false });
  });

  it.each(["release_and_rerun", "keep_spent_and_rerun"] as const)("a_check_racing_%s_stops_and_never_settles_twice", async (choice) => {
    const { stageId } = await park();
    const racing: JobChecker = {
      async check() {
        // the owner resolves in another tab while the provider is being asked
        expect(await resolveDecision(db.pool, q, { stageRunId: stageId, choice, actor: SESSION })).toMatchObject({ ok: true });
        return { kind: "done", artifact: ART };
      },
    };
    expect(await checkParkedJob(db.pool, { fal_image: racing }, { stageRunId: stageId, actor: SESSION })).toMatchObject({ ok: false });
    const b = await budget();
    expect(b.reservedMicroUsd).toBe(0);
    expect(b.spentMicroUsd).toBe(choice === "keep_spent_and_rerun" ? RESERVE : 0);
    expect(await intents(stageId)).toHaveLength(1);
    expect((await job(stageId)).state).toBe("submitted");
    expect(await audits()).toEqual([]);
  });

  it("a_crash_between_saving_the_file_and_the_transaction_settles_once_on_retry", async () => {
    const { stageId } = await park();
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), "jc-root-")));
    const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
    const paths: string[] = [];
    let crash = true;
    const checker: JobChecker = {
      async check(j) {
        const artifact = await saveImage(PNG, { provider: "fal_image", model: "m", prompt: "p", refs: [], root, priceMicroUsd: j.quoteMicroUsd });
        paths.push(artifact.path);
        if (crash) throw new Error("process died after the file was saved");
        return { kind: "done", artifact };
      },
    };
    expect(await checkParkedJob(db.pool, { fal_image: checker }, { stageRunId: stageId, actor: SESSION })).toMatchObject({ outcome: "unknown" });
    expect(await budget()).toMatchObject({ reservedMicroUsd: RESERVE, spentMicroUsd: 0 });
    crash = false;
    expect(await checkParkedJob(db.pool, { fal_image: checker }, { stageRunId: stageId, actor: SESSION })).toMatchObject({ outcome: "done" });
    expect(paths[1]).toBe(paths[0]);
    expect(readdirSync(root, { recursive: true, withFileTypes: true }).filter((e) => e.isFile() && e.name.endsWith(".png"))).toHaveLength(1);
    expect(await budget()).toMatchObject({ reservedMicroUsd: 0, spentMicroUsd: RESERVE });
    expect(await intents(stageId)).toMatchObject([{ status: "done", actual: RESERVE }]);
  });
});
