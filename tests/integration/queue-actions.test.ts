import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sha256Hex } from "@/server/core/content-hash";
import { buildEngineConfig } from "@/server/core/engine-config";
import { STALE_MESSAGE, versionsKey, type DecisionInput, type GateInput } from "@/server/core/queue-input";
import type { StageHandler } from "@/server/core/stage-handler";
import type { StageRunnerDeps } from "@/server/core/stage-runner";
import { approvalReaders } from "@/server/db/approval-readers";
import { approveGate, liveGateHash } from "@/server/db/approvals";
import { recordBreakerEvent } from "@/server/db/breakers";
import { advanceVideo, cancelVideo, readNextAction } from "@/server/db/pipeline";
import { readUploadTarget, recheckPublishStart } from "@/server/db/publish";
import { refuseDryRunVideos } from "@/worker/handlers";
import { loadQueue } from "@/server/db/queue-data";
import { cancelVideoById, decideGate, decideParkedStage, resetBreakerFor, sendUploadAgain, startDryRun, type Queues } from "@/server/db/queue-actions";
import { reconcile } from "@/server/db/reconciler";
import { runStage } from "@/server/db/stage-runner-adapter";
import { claimStage, commitStage, getStage } from "@/server/db/stages";
import { addContent, createVideoRow } from "@/server/db/videos";
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

const SESSION_ID = "0190f3a2-7c1e-7a55-9d3b-2f6c8a1b4e91";
const actor = { kind: "session", sessionId: SESSION_ID } as const;
const config = buildEngineConfig(new Map());

beforeEach(async () => {
  await db.reset();
  await db.ownerPool.query(await readFile("src/server/db/migrations/0014_breakers.sql", "utf8"));
  provider = createFakeProvider({ pool: db.pool });
  await provider.init();
  await db.ownerPool.query("truncate fake_provider_calls");
  await db.pool.query("insert into budgets (scope, cap_micro_usd) values ('g', 100000000)");
  await db.ownerPool.query(
    "insert into sessions (id, token_hash, expires_at, absolute_expires_at) values ($1, 'queue-test', clock_timestamp() + interval '1 day', clock_timestamp() + interval '7 days')",
    [SESSION_ID],
  );
});

interface FakeQueues extends Queues {
  stageCalls: string[];
  uploadCalls: string[];
  failUpload: boolean;
}
function fakeQueues(): FakeQueues {
  const q: FakeQueues = {
    stageCalls: [],
    uploadCalls: [],
    failUpload: false,
    stage: {
      async enqueue(id, fence, attemptSeq) {
        q.stageCalls.push(id);
        return `stage.${id}.${fence}.${attemptSeq}`;
      },
    },
    upload: {
      async enqueueUpload(id) {
        if (q.failUpload) throw new Error("redis down");
        q.uploadCalls.push(id);
        return `upload.${id}`;
      },
    },
  };
  return q;
}

const script = (title = "Why the sky is blue") => ({
  title,
  description: "Short explainer",
  narration: "The sky looks blue because air scatters blue light more than red light.",
  beats: [{ id: "hook", text: "hook" }],
  evidence: [{ text: "Air scatters blue light", kind: "sourced", source_url: "https://example.test/a", quote: "scatters blue light" }],
});
const plan = { providers_models: { llm: "m1" }, path: "scene_kit", library_scene_versions: { a: 1 }, quote: { micro_usd: "2500000" }, items: [{ kind: "image", provider: "fakeimg", quoteMicroUsd: 2_500_000 }] };

async function seedScriptVideo(): Promise<string> {
  const v = await createVideoRow(db.pool, { format: "short", kind: "scene_kit", language: "en", topic: "Why the sky is blue", channelId: "UC1" });
  await addContent(db.pool, v.id, "script", { body: script(), sha256: sha256Hex("script-1") });
  return v.id;
}
/** The draft stage ran and succeeded (as a worker would), so the next thing the pipeline says is the script gate. */
async function draftDone(videoId: string, q: FakeQueues) {
  await advanceVideo(db.pool, q.stage, videoId, approvalReaders);
  const { rows } = await db.pool.query<{ id: string; input_hash: string }>("select id, input_hash from stage_runs where video_id = $1 and name = 'draft'", [videoId]);
  const c = await claimStage(db.pool, { id: rows[0]!.id, inputHash: rows[0]!.input_hash, workerId: "w", ttlMs: 60_000 });
  if (!c) throw new Error("no claim");
  await commitStage(db.pool, c, {});
  q.stageCalls.length = 0;
  return rows[0]!.id;
}
async function inputFor(videoId: string, gate: GateInput["gate"], over: Partial<GateInput> = {}): Promise<GateInput> {
  const live = (await liveGateHash(db.pool, videoId, gate))!;
  return { videoId, gate, seenHash: live.hash, seenVersions: versionsKey(live.versions), note: undefined, ...over };
}
const approvalsOf = async (videoId: string) => (await db.pool.query("select gate, decision, note from approvals where video_id = $1 order by seq", [videoId])).rows as Array<{ gate: string; decision: string; note: string | null }>;
const auditEvents = async () => (await db.ownerPool.query("select event from audit_log order by id")).rows.map((r) => r.event as string);

describe("approval readers (the pipeline's real view of the owner's decisions)", () => {
  it("a script approval opens the next stage, and a new script version closes it again", async () => {
    const q = fakeQueues();
    const videoId = await seedScriptVideo();
    await draftDone(videoId, q);
    expect(await readNextAction(db.pool, videoId, approvalReaders)).toMatchObject({ kind: "wait_gate", gate: "script" });
    expect((await decideGate(db.pool, q, actor, await inputFor(videoId, "script"), "approve")).ok).toBe(true);
    expect(await readNextAction(db.pool, videoId, approvalReaders)).toMatchObject({ kind: "wait_stage", stage: "build" });
    await addContent(db.pool, videoId, "script", { body: script("A different title"), sha256: sha256Hex("script-2") });
    expect(await readNextAction(db.pool, videoId, approvalReaders)).toMatchObject({ kind: "wait_gate", gate: "script" });
  });
  it("the newest script send-back note becomes the draft's feedback", async () => {
    const q = fakeQueues();
    const videoId = await seedScriptVideo();
    await draftDone(videoId, q);
    const client = await db.pool.connect();
    try {
      expect(await approvalReaders.feedback(client, videoId)).toBeNull();
      await decideGate(db.pool, q, actor, await inputFor(videoId, "script", { note: "make it shorter" }), "send_back");
      expect(await approvalReaders.feedback(client, videoId)).toBe("make it shorter");
    } finally {
      client.release();
    }
  });
});

describe("decideGate: approve and send back", () => {
  it("approves what the page rendered, advances the video and audits it", async () => {
    const q = fakeQueues();
    const videoId = await seedScriptVideo();
    await draftDone(videoId, q);
    const r = await decideGate(db.pool, q, actor, await inputFor(videoId, "script"), "approve");
    expect(r).toEqual({ ok: true, message: "Approved." });
    expect(await approvalsOf(videoId)).toEqual([{ gate: "script", decision: "approved", note: null }]);
    expect(q.stageCalls.length).toBe(1); // build was queued
    expect(await auditEvents()).toContain("gate.approved");
  });
  it("approving the same page twice records one approval and the second says it is no longer waiting", async () => {
    const q = fakeQueues();
    const videoId = await seedScriptVideo();
    await draftDone(videoId, q);
    const i = await inputFor(videoId, "script");
    expect((await decideGate(db.pool, q, actor, i, "approve")).ok).toBe(true);
    expect((await decideGate(db.pool, q, actor, i, "approve")).ok).toBe(false);
    expect(await approvalsOf(videoId)).toHaveLength(1);
  });
  it("a hash forged by the page is refused and nothing is written", async () => {
    const q = fakeQueues();
    const videoId = await seedScriptVideo();
    await draftDone(videoId, q);
    for (const seenHash of ["0".repeat(64), sha256Hex("forged")]) {
      expect(await decideGate(db.pool, q, actor, await inputFor(videoId, "script", { seenHash }), "approve")).toEqual({ ok: false, message: STALE_MESSAGE });
    }
    expect(await approvalsOf(videoId)).toEqual([]);
    expect(q.stageCalls).toEqual([]);
  });
  it("a page rendered before the content changed is refused: right old hash, new content", async () => {
    const q = fakeQueues();
    const videoId = await seedScriptVideo();
    await draftDone(videoId, q);
    const old = await inputFor(videoId, "script");
    await addContent(db.pool, videoId, "script", { body: script("Edited while you were looking"), sha256: sha256Hex("script-2") });
    expect(await decideGate(db.pool, q, actor, old, "approve")).toEqual({ ok: false, message: STALE_MESSAGE });
    expect(await decideGate(db.pool, q, actor, old, "send_back")).toEqual({ ok: false, message: STALE_MESSAGE });
    expect(await approvalsOf(videoId)).toEqual([]);
  });
  it("the right hash with different content versions is refused too", async () => {
    const q = fakeQueues();
    const videoId = await seedScriptVideo();
    await draftDone(videoId, q);
    const ok = await inputFor(videoId, "script");
    const other = ok.seenVersions.replace(/:1$/, ":2");
    expect(other).not.toBe(ok.seenVersions);
    expect(await decideGate(db.pool, q, actor, { ...ok, seenVersions: other }, "approve")).toEqual({ ok: false, message: STALE_MESSAGE });
    expect(await approvalsOf(videoId)).toEqual([]);
  });
  it("only a session can act: a token, a job or a system actor changes nothing at all", async () => {
    const q = fakeQueues();
    const videoId = await seedScriptVideo();
    await draftDone(videoId, q);
    const i = await inputFor(videoId, "script", { note: "note here" });
    for (const kind of ["token", "job", "system"]) {
      const bad = { kind, sessionId: SESSION_ID } as never;
      expect((await decideGate(db.pool, q, bad, i, "approve")).ok).toBe(false);
      expect((await decideGate(db.pool, q, bad, i, "send_back")).ok).toBe(false);
      expect((await cancelVideoById(db.pool, bad, videoId)).ok).toBe(false);
      expect((await resetBreakerFor(db.pool, bad, "draft")).ok).toBe(false);
      expect((await sendUploadAgain(db.pool, q, bad, "11111111-1111-4111-8111-111111111111")).ok).toBe(false);
      expect((await startDryRun(db.pool, q, bad)).ok).toBe(false);
    }
    expect(await approvalsOf(videoId)).toEqual([]);
    expect((await db.pool.query("select status from videos where id = $1", [videoId])).rows[0].status).not.toBe("cancelled");
    expect((await db.pool.query("select count(*)::int as n from videos")).rows[0].n).toBe(1);
  });
  it("send back keeps the note, holds the gate and reruns the draft with the note", async () => {
    const q = fakeQueues();
    const videoId = await seedScriptVideo();
    const firstDraft = await draftDone(videoId, q);
    const r = await decideGate(db.pool, q, actor, await inputFor(videoId, "script", { note: "make it shorter" }), "send_back");
    expect(r.ok).toBe(true);
    expect(await approvalsOf(videoId)).toEqual([{ gate: "script", decision: "sent_back", note: "make it shorter" }]);
    const drafts = (await db.pool.query<{ id: string; status: string }>("select id, status from stage_runs where video_id = $1 and name = 'draft' order by created_at, id", [videoId])).rows;
    expect(drafts).toHaveLength(2);
    expect(drafts[0]!.id).toBe(firstDraft);
    expect(drafts[1]!.status).toBe("queued");
    expect(q.stageCalls).toEqual([drafts[1]!.id]);
    // The same content cannot then be approved.
    expect((await decideGate(db.pool, q, actor, await inputFor(videoId, "script"), "approve")).ok).toBe(false);
  });
  it("a note of one or two characters never reaches the core", async () => {
    const q = fakeQueues();
    const videoId = await seedScriptVideo();
    await draftDone(videoId, q);
    expect((await decideGate(db.pool, q, actor, await inputFor(videoId, "script", { note: "ab" }), "send_back")).ok).toBe(false);
    expect(await approvalsOf(videoId)).toEqual([]);
  });
  it("a Redis outage after the approval still records it (the sweep delivers the stage)", async () => {
    const q = fakeQueues();
    q.stage.enqueue = async () => {
      throw new Error("redis down");
    };
    const videoId = await seedScriptVideo();
    await draftDone(videoId, q);
    expect((await decideGate(db.pool, q, actor, await inputFor(videoId, "script"), "approve")).ok).toBe(true);
    expect((await db.pool.query("select status from stage_runs where video_id = $1 and name = 'build'", [videoId])).rows[0].status).toBe("queued");
  });
});

describe("decideGate: publish", () => {
  async function publishReady() {
    const q = fakeQueues();
    const root = mkdtempSync(path.join(tmpdir(), "queue-publish-"));
    mkdirSync(path.join(root, "v"), { recursive: true });
    writeFileSync(path.join(root, "v/1.mp4"), "video-1");
    const v = await createVideoRow(db.pool, { format: "short", kind: "scene_kit", language: "en", topic: "Publish me", channelId: "UC1" });
    await addContent(db.pool, v.id, "script", { body: script(), sha256: sha256Hex("script-1") });
    await addContent(db.pool, v.id, "video", { filePath: "v/1.mp4", sha256: sha256Hex("video-1") });
    await addContent(db.pool, v.id, "evidence", { filePath: "e/1.pdf", sha256: sha256Hex("evidence-1") });
    await addContent(db.pool, v.id, "metadata", { body: { title: "Publish me", visibility: "private", publish_at: null }, sha256: sha256Hex("meta-1") });
    for (const g of ["video", "evidence"] as const) await approveGate(db.pool, { videoId: v.id, gate: g, seenHash: (await liveGateHash(db.pool, v.id, g))!.hash, actor });
    // Every stage ran (as a worker would) and the script was approved: the pipeline now waits at the publish gate.
    for (const stage of ["draft", "build", "tts", "render", "voice", "sfx", "qa"]) {
      await advanceVideo(db.pool, q.stage, v.id, approvalReaders);
      const { rows } = await db.pool.query<{ id: string; input_hash: string }>("select id, input_hash from stage_runs where video_id = $1 and name = $2 and status = 'queued'", [v.id, stage]);
      const c = await claimStage(db.pool, { id: rows[0]!.id, inputHash: rows[0]!.input_hash, workerId: "w", ttlMs: 60_000 });
      await commitStage(db.pool, c!, {});
      if (stage === "draft") await approveGate(db.pool, { videoId: v.id, gate: "script", seenHash: (await liveGateHash(db.pool, v.id, "script"))!.hash, actor });
    }
    await advanceVideo(db.pool, q.stage, v.id, approvalReaders);
    q.stageCalls.length = 0;
    return { q, root, videoId: v.id };
  }
  it("approves the publish once, queues the upload and rejects a replay of the same page", async () => {
    const { q, root, videoId } = await publishReady();
    const i = await inputFor(videoId, "publish");
    const r = await decideGate(db.pool, q, actor, i, "approve", { root });
    expect(r).toEqual({ ok: true, message: "Approved. The upload is queued." });
    expect(q.uploadCalls).toHaveLength(1);
    expect((await decideGate(db.pool, q, actor, i, "approve", { root })).ok).toBe(false);
    expect(q.uploadCalls).toHaveLength(1);
    expect((await db.pool.query("select count(*)::int as n from uploads where video_id = $1", [videoId])).rows[0].n).toBe(1);
  });
  it("changing the metadata after the page rendered voids the publish approval attempt", async () => {
    const { q, root, videoId } = await publishReady();
    const i = await inputFor(videoId, "publish");
    await addContent(db.pool, videoId, "metadata", { body: { title: "Publish me", visibility: "public", publish_at: null }, sha256: sha256Hex("meta-2") });
    expect(await decideGate(db.pool, q, actor, i, "approve", { root })).toEqual({ ok: false, message: STALE_MESSAGE });
    expect((await db.pool.query("select count(*)::int as n from uploads")).rows[0].n).toBe(0);
  });
  it("public stays refused while allow_public is off, with a sentence", async () => {
    const { q, root, videoId } = await publishReady();
    await addContent(db.pool, videoId, "metadata", { body: { title: "Publish me", visibility: "public", publish_at: null }, sha256: sha256Hex("meta-2") });
    const r = await decideGate(db.pool, q, actor, await inputFor(videoId, "publish"), "approve", { root });
    expect(r.ok).toBe(false);
    expect(r.message.length).toBeGreaterThan(10);
    expect(q.uploadCalls).toEqual([]);
  });
  it("an upload that could not be queued says so, and Send again delivers it once", async () => {
    const { q, root, videoId } = await publishReady();
    q.failUpload = true;
    const r = await decideGate(db.pool, q, actor, await inputFor(videoId, "publish"), "approve", { root });
    expect(r.ok).toBe(true);
    expect(r.message).toContain("Send again");
    const queue = await loadQueue(db.pool);
    expect(queue.stranded).toHaveLength(1);
    q.failUpload = false;
    const again = await sendUploadAgain(db.pool, q, actor, queue.stranded[0]!.uploadId);
    expect(again.ok).toBe(true);
    expect(q.uploadCalls).toEqual([queue.stranded[0]!.uploadId]);
    expect(await auditEvents()).toContain("upload.requeued");
    // A random id, or an upload that is not publish_approved, is a no-op.
    expect((await sendUploadAgain(db.pool, q, actor, "11111111-1111-4111-8111-111111111111")).ok).toBe(false);
    await db.ownerPool.query("update uploads set status = 'uploading', attempt = 1, started_at = now()");
    expect((await sendUploadAgain(db.pool, q, actor, queue.stranded[0]!.uploadId)).ok).toBe(false);
  });
});

describe("loadQueue", () => {
  it("is empty when nothing waits", async () => {
    expect(await loadQueue(db.pool)).toEqual({ items: [], breakers: [], stranded: [] });
  });
  it("lists a gate with the hash and versions it was read with, and the script content", async () => {
    const q = fakeQueues();
    const videoId = await seedScriptVideo();
    await draftDone(videoId, q);
    await advanceVideo(db.pool, q.stage, videoId, approvalReaders); // moves the video to 'waiting'
    const { items } = await loadQueue(db.pool);
    expect(items).toHaveLength(1);
    const item = items[0]!;
    expect(item.kind).toBe("gate");
    if (item.kind !== "gate") return;
    const live = (await liveGateHash(db.pool, videoId, "script"))!;
    expect(item.hash).toBe(live.hash);
    expect(item.versions).toBe(versionsKey(live.versions));
    expect(item.content).toMatchObject({ kind: "script", title: "Why the sky is blue", words: 13 });
    expect(item.strip).toMatchObject({ openGate: "script", runs: { draft: "succeeded" } });
  });
  it("shows the cost plan's dollar total", async () => {
    const q = fakeQueues();
    const videoId = await seedScriptVideo();
    await addContent(db.pool, videoId, "cost_plan", { body: plan, sha256: sha256Hex("plan-1") });
    await draftDone(videoId, q);
    await decideGate(db.pool, q, actor, await inputFor(videoId, "script"), "approve");
    // build succeeds (as a worker would), then the cost gate opens because the plan has paid items
    const { rows } = await db.pool.query<{ id: string; input_hash: string }>("select id, input_hash from stage_runs where video_id = $1 and name = 'build'", [videoId]);
    const c = await claimStage(db.pool, { id: rows[0]!.id, inputHash: rows[0]!.input_hash, workerId: "w", ttlMs: 60_000 });
    await commitStage(db.pool, c!, {});
    await advanceVideo(db.pool, q.stage, videoId, approvalReaders);
    const { items } = await loadQueue(db.pool);
    expect(items[0]).toMatchObject({ kind: "gate", gate: "cost", content: { kind: "cost", totalMicroUsd: 2_500_000, path: "scene_kit" } });
  });
});

describe("parked stages", () => {
  const RESERVE = 400_000;
  const deps = (handler: StageHandler): StageRunnerDeps => ({ provider: { call: (key) => provider.call(key) }, ttlMs: 300, workerId: "w", handler, config });
  async function park(q: FakeQueues) {
    const v = await createVideoRow(db.pool, { format: "short", kind: "scene_kit", language: "en", topic: "Parked video" });
    await advanceVideo(db.pool, q.stage, v.id, approvalReaders);
    const { rows } = await db.pool.query<{ id: string }>("select id from stage_runs where video_id = $1", [v.id]);
    const stageId = rows[0]!.id;
    const row = (await getStage(db.pool, stageId))!;
    const handler: StageHandler = (ctx) =>
      ctx.paid({ reserveMicroUsd: RESERVE, budgetScopes: ["g"], kind: "cheap_text" }, async () => {
        throw new Error("socket hang up");
      });
    await expect(runStage(db.pool, deps(handler), { stageRunId: stageId, inputHash: row.inputHash })).rejects.toThrow(/socket hang up/);
    await db.ownerPool.query("update stage_runs set lease_until = clock_timestamp() - interval '1 second' where id = $1", [stageId]);
    expect((await reconcile(db.pool, q.stage as never, { graceMs: 0 })).needsDecision).toEqual([stageId]);
    return { videoId: v.id, stageId };
  }
  const decisionInput = (stageRunId: string, over: Partial<DecisionInput> = {}): DecisionInput => ({ stageRunId, choice: "release_and_rerun", seenMaxMicroUsd: RESERVE, seenReason: "paid_call_may_have_run", confirmed: true, ...over });

  it("the queue shows the parked step with the dollar figure (the reservation) and the three choices", async () => {
    const q = fakeQueues();
    (q.stage as { liveJobIds?: () => Promise<Set<string>> }).liveJobIds = async () => new Set();
    const { stageId } = await park(q);
    const { items } = await loadQueue(db.pool);
    expect(items).toHaveLength(1);
    const d = items[0]!;
    expect(d.kind).toBe("decision");
    if (d.kind !== "decision") return;
    expect(d.decision.stageRunId).toBe(stageId);
    expect(d.decision.maxCostMicroUsd).toBe(RESERVE);
    expect(d.decision.summary).toContain("$0.40");
    expect(d.decision.choices).toEqual(["release_and_rerun", "keep_spent_and_rerun", "cancel_video"]);
  });
  it("refuses a figure the page did not show, an unconfirmed release, and a choice the stage does not offer", async () => {
    const q = fakeQueues();
    (q.stage as { liveJobIds?: () => Promise<Set<string>> }).liveJobIds = async () => new Set();
    const { stageId } = await park(q);
    expect(await decideParkedStage(db.pool, q, actor, decisionInput(stageId, { seenMaxMicroUsd: 1 }))).toEqual({ ok: false, message: STALE_MESSAGE });
    expect((await decideParkedStage(db.pool, q, actor, decisionInput(stageId, { confirmed: false }))).message).toContain("Tick the box");
    expect((await decideParkedStage(db.pool, q, actor, decisionInput(stageId, { choice: "use_result" }))).ok).toBe(false);
    expect((await getStage(db.pool, stageId))!.status).toBe("needs_decision");
    for (const kind of ["token", "job", "system"]) expect((await decideParkedStage(db.pool, q, { kind, sessionId: SESSION_ID } as never, decisionInput(stageId))).ok).toBe(false);
    expect((await getStage(db.pool, stageId))!.status).toBe("needs_decision");
  });
  it("a confirmed release reruns the step; resolving twice changes nothing the second time", async () => {
    const q = fakeQueues();
    (q.stage as { liveJobIds?: () => Promise<Set<string>> }).liveJobIds = async () => new Set();
    const { stageId, videoId } = await park(q);
    expect((await decideParkedStage(db.pool, q, actor, decisionInput(stageId))).ok).toBe(true);
    expect((await decideParkedStage(db.pool, q, actor, decisionInput(stageId))).ok).toBe(false);
    expect((await db.pool.query("select count(*)::int as n from stage_runs where video_id = $1 and name = 'draft'", [videoId])).rows[0].n).toBe(2);
    expect(await auditEvents()).toContain("stage.decision");
  });
  it("cancel needs no billing check and cancels the video with an audit row", async () => {
    const q = fakeQueues();
    (q.stage as { liveJobIds?: () => Promise<Set<string>> }).liveJobIds = async () => new Set();
    const { stageId, videoId } = await park(q);
    expect((await decideParkedStage(db.pool, q, actor, decisionInput(stageId, { choice: "cancel_video", confirmed: false }))).ok).toBe(true);
    expect((await db.pool.query("select status from videos where id = $1", [videoId])).rows[0].status).toBe("cancelled");
  });
});

describe("breaker, cancel and dry run", () => {
  it("shows an open breaker with its time and the session can release it, with an audit row", async () => {
    for (let n = 0; n < 3; n++) await recordBreakerEvent(db.pool, "draft", "failure");
    const open = (await loadQueue(db.pool)).breakers;
    expect(open.map((b) => b.stage)).toEqual(["draft"]);
    expect((await resetBreakerFor(db.pool, actor, "draft")).ok).toBe(true);
    expect((await loadQueue(db.pool)).breakers).toEqual([]);
    expect(await auditEvents()).toContain("breaker.reset");
  });
  it("cancelVideoById cancels and audits; an unknown id is a sentence, not a crash", async () => {
    const videoId = await seedScriptVideo();
    expect((await cancelVideoById(db.pool, actor, videoId)).ok).toBe(true);
    expect((await db.pool.query("select status from videos where id = $1", [videoId])).rows[0].status).toBe("cancelled");
    expect(await auditEvents()).toContain("video.cancelled");
    expect((await cancelVideoById(db.pool, actor, "11111111-1111-4111-8111-111111111111")).ok).toBe(false);
  });
  it("startDryRun makes one marked video, queues its draft and audits it (throwaway database opt-in given)", async () => {
    const q = fakeQueues();
    expect((await startDryRun(db.pool, q, actor, { ENGINE_DRY_RUN: "1", NODE_ENV: "development", ENGINE_DRY_RUN_DB_OK: "1" })).ok).toBe(true);
    expect((await db.pool.query("select count(*)::int as n from videos where notes = 'dry run'")).rows[0].n).toBe(1);
    expect(q.stageCalls).toHaveLength(1);
    expect(await auditEvents()).toContain("dryrun.started");
  });
});

describe("dry run guard (development mode must not spend real money)", () => {
  const env = { ENGINE_DRY_RUN: "1", NODE_ENV: "development", ENGINE_DRY_RUN_DB_OK: "1" };
  it("is refused without ENGINE_DRY_RUN=1, in production, and on a database not marked throwaway", async () => {
    const q = fakeQueues();
    for (const bad of [{ ...env, ENGINE_DRY_RUN: "0" }, { ...env, NODE_ENV: "production" }, { NODE_ENV: "development", ENGINE_DRY_RUN: "1" }]) {
      expect((await startDryRun(db.pool, q, actor, bad)).ok, JSON.stringify(bad)).toBe(false);
    }
    expect((await db.pool.query("select count(*)::int as n from videos")).rows[0].n).toBe(0);
  });
  it("the production worker refuses a dry-run video before any real provider is touched", async () => {
    const v = await createVideoRow(db.pool, { format: "short", kind: "scene_kit", language: "en", topic: "dry", notes: "dry run" });
    const real = await createVideoRow(db.pool, { format: "short", kind: "scene_kit", language: "en", topic: "real" });
    let calls = 0;
    const handler = refuseDryRunVideos(db.pool, async () => ((calls += 1), "ran"));
    const ctx = (videoId: string) => ({ stage: { id: "s", name: "draft", inputHash: "h", videoId } }) as never;
    await expect(handler(ctx(v.id))).rejects.toThrow(/dry-run video/);
    expect(calls).toBe(0);
    await expect(handler(ctx(real.id))).resolves.toBe("ran");
  });
});

describe("a cancelled video does nothing more", () => {
  async function approvedUpload() {
    const q = fakeQueues();
    const root = mkdtempSync(path.join(tmpdir(), "queue-cancel-"));
    mkdirSync(path.join(root, "v"), { recursive: true });
    writeFileSync(path.join(root, "v/1.mp4"), "video-1");
    const v = await createVideoRow(db.pool, { format: "short", kind: "scene_kit", language: "en", topic: "Cancel me", channelId: "UC1" });
    await addContent(db.pool, v.id, "script", { body: script(), sha256: sha256Hex("script-1") });
    await addContent(db.pool, v.id, "video", { filePath: "v/1.mp4", sha256: sha256Hex("video-1") });
    await addContent(db.pool, v.id, "evidence", { filePath: "e/1.pdf", sha256: sha256Hex("evidence-1") });
    await addContent(db.pool, v.id, "metadata", { body: { title: "Cancel me", visibility: "private", publish_at: null }, sha256: sha256Hex("meta-1") });
    for (const g of ["video", "evidence"] as const) await approveGate(db.pool, { videoId: v.id, gate: g, seenHash: (await liveGateHash(db.pool, v.id, g))!.hash, actor });
    return { q, root, videoId: v.id };
  }
  it("a stale tab cannot approve a cancelled video, at any gate", async () => {
    const q = fakeQueues();
    const videoId = await seedScriptVideo();
    await draftDone(videoId, q);
    const i = await inputFor(videoId, "script");
    expect((await cancelVideoById(db.pool, actor, videoId)).ok).toBe(true);
    expect(await decideGate(db.pool, q, actor, i, "approve")).toEqual({ ok: false, message: "This video is no longer in production." });
    expect((await decideGate(db.pool, q, actor, { ...i, note: "fix it please" }, "send_back")).ok).toBe(false);
    expect(await approvalsOf(videoId)).toEqual([]);
  });
  it("approvePublish itself refuses a cancelled video (not only the page)", async () => {
    const { root, videoId } = await approvedUpload();
    const { approvePublish } = await import("@/server/db/publish");
    const seen = (await liveGateHash(db.pool, videoId, "publish"))!.hash;
    await cancelVideo(db.pool, videoId);
    const r = await approvePublish(db.pool, { enqueueUpload: async () => "x" }, { videoId, seenHash: seen, visibility: "private", publishAt: null, channelId: "UC1", actor }, { root });
    expect(r.ok).toBe(false);
    expect((await db.pool.query("select count(*)::int as n from uploads")).rows[0].n).toBe(0);
  });
  it("Send again, the stranded list, the job-time read and the start recheck all ignore an approved upload of a cancelled video", async () => {
    const { q, root, videoId } = await approvedUpload();
    const seen = (await liveGateHash(db.pool, videoId, "publish"))!.hash;
    const { approvePublish } = await import("@/server/db/publish");
    const ok = await approvePublish(db.pool, { enqueueUpload: async () => { throw new Error("down"); } }, { videoId, seenHash: seen, visibility: "private", publishAt: null, channelId: "UC1", actor }, { root });
    expect(ok.ok).toBe(true);
    const uploadId = (ok as { uploadId: string }).uploadId;
    expect((await loadQueue(db.pool)).stranded).toHaveLength(1);
    await cancelVideoById(db.pool, actor, videoId);
    expect((await loadQueue(db.pool)).stranded).toEqual([]);
    expect((await sendUploadAgain(db.pool, q, actor, uploadId)).ok).toBe(false);
    expect(q.uploadCalls).toEqual([]);
    const target = await readUploadTarget(db.pool, uploadId, { root });
    expect(target).toMatchObject({ ok: false, reason: "policy" });
    const c = await db.pool.connect();
    try {
      expect(await recheckPublishStart(c, { videoId, approvalHash: seen })).toBe("policy");
    } finally {
      c.release();
    }
  });
  it("cancelVideo does nothing to a finished or failed video", async () => {
    for (const status of ["done", "failed"]) {
      const v = await createVideoRow(db.pool, { format: "short", kind: "scene_kit", language: "en", topic: status });
      await db.ownerPool.query("update videos set status = $2 where id = $1", [v.id, status]);
      expect(await cancelVideo(db.pool, v.id)).toEqual({ flagged: [] });
      expect((await db.pool.query("select status from videos where id = $1", [v.id])).rows[0].status).toBe(status);
    }
  });
});

describe("decisions are exact", () => {
  it("two simultaneous clicks on the same page record one approval", async () => {
    const q = fakeQueues();
    const videoId = await seedScriptVideo();
    await draftDone(videoId, q);
    const i = await inputFor(videoId, "script");
    const rs = await Promise.all([decideGate(db.pool, q, actor, i, "approve"), decideGate(db.pool, q, actor, i, "approve"), decideGate(db.pool, q, actor, i, "approve")]);
    expect(rs.filter((r) => r.ok)).toHaveLength(1);
    expect(await approvalsOf(videoId)).toHaveLength(1);
  });
  it("a gate the pipeline is not waiting at is refused, even with a correct hash for it", async () => {
    const q = fakeQueues();
    const videoId = await seedScriptVideo();
    await addContent(db.pool, videoId, "video", { filePath: "v/x.mp4", sha256: sha256Hex("v") });
    await draftDone(videoId, q);
    const wrong = await inputFor(videoId, "video");
    expect(await decideGate(db.pool, q, actor, wrong, "approve")).toEqual({ ok: false, message: "This is no longer waiting for you." });
    expect((await decideGate(db.pool, q, actor, { ...wrong, note: "no thanks" }, "send_back")).ok).toBe(false);
    expect(await approvalsOf(videoId)).toEqual([]);
  });
  it("the pipeline ignores an approval whose session did not exist (a row written by hand)", async () => {
    const q = fakeQueues();
    const videoId = await seedScriptVideo();
    await draftDone(videoId, q);
    const live = (await liveGateHash(db.pool, videoId, "script"))!;
    const ghost = "22222222-2222-4222-8222-222222222222";
    await db.pool.query("insert into approvals (video_id, gate, content_hash, content_versions, decision, decided_by, session_id) values ($1, 'script', $2, $3::jsonb, 'approved', 'session', $4)", [videoId, live.hash, JSON.stringify(live.versions), ghost]);
    expect(await readNextAction(db.pool, videoId, approvalReaders)).toMatchObject({ kind: "wait_gate", gate: "script" });
    await advanceVideo(db.pool, q.stage, videoId, approvalReaders);
    expect(q.stageCalls).toEqual([]);
  });
});
