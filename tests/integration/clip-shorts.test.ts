import { copyFileSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildEngineConfig } from "@/server/core/engine-config";
import { canonicalJson, sha256Hex } from "@/server/core/content-hash";
import { uuidv7 } from "@/server/core/ids";
import type { StageHandler } from "@/server/core/stage-handler";
import type { StageOutcome } from "@/server/core/stage-runner";
import { approveGate, liveGateHash } from "@/server/db/approvals";
import { approvalReaders } from "@/server/db/approval-readers";
import { createClipShorts } from "@/server/db/clip-shorts";
import { advanceVideo, readNextAction } from "@/server/db/pipeline";
import { runStage } from "@/server/db/stage-runner-adapter";
import { insertQueuedStage } from "@/server/db/stages";
import { addContent, createVideoRow, latestContent } from "@/server/db/videos";
import { createFakeImage } from "@/server/providers/media/fake";
import { createFakeRenderer } from "@/server/providers/renderer/fake";
import type { ClipRenderInput } from "@/server/providers/renderer/clip-render";
import { createFakeVoice } from "@/server/providers/voice/fake";
import { runChild, type ChildSpec } from "@/server/render/child";
import { withAttempt } from "@/worker/stages/attempt";
import { clipsAttempt } from "@/worker/stages/clips";
import type { StageDeps } from "@/worker/stages/deps";
import { qaAttempt } from "@/worker/stages/qa";
import { withTestDb, type TestDb } from "../support/db";
import { assertFfprobeAvailable } from "../support/tools";

// Clip Factory CF4b-2: a chosen clip becomes its own Short that waits at the normal gates. The script is inherited (the window's narration
// and only the claims the clip states), the owner approves it, QA checks the clip file, then the video gate opens. Nothing is approved here.

let db: TestDb;
let root: string;
const SESSION = { kind: "session", sessionId: "11111111-1111-4111-8111-111111111111" } as const;
beforeAll(async () => {
  assertFfprobeAvailable();
  db = await withTestDb();
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "clip-shorts-")));
});
afterAll(async () => {
  rmSync(root, { recursive: true, force: true });
  await db?.stop();
});
beforeEach(async () => {
  await db.reset();
  await db.pool.query("insert into sessions (id, token_hash, expires_at, absolute_expires_at) values ($1, 'clip-shorts', clock_timestamp() + interval '1 day', clock_timestamp() + interval '7 days') on conflict (id) do nothing", [SESSION.sessionId]);
});

const noProvider = { call: async () => Promise.reject(new Error("no provider in handler mode")) };
async function play(videoId: string, name: string, handler: StageHandler): Promise<StageOutcome> {
  const inputHash = `h-${name}-${uuidv7()}`;
  const stageRunId = await insertQueuedStage(db.pool, { videoId, name, inputHash });
  return runStage(db.pool, { provider: noProvider, ttlMs: 60_000, workerId: "w1", handler, config: buildEngineConfig(new Map()) }, { stageRunId, inputHash });
}
const queued: string[] = [];
const queue = { enqueue: async (id: string) => { queued.push(id); return "job"; } };

const SKY = "Blue light scatters ten times more than red light";
const OZONE = "Ozone absorbs ultraviolet radiation in the stratosphere";
function words() {
  const out: { word: string; startS: number; endS: number }[] = [];
  let t = 0;
  for (let s = 0; s < 20; s++) {
    const text = s % 3 === 0 ? `Why ${SKY} at noon?` : `Point ${s} w1 w2 w3 w4 w5 w6 w7 w8 w9 end.`; // every clip holds one sentence that states the sky claim
    for (const word of text.split(" ")) { out.push({ word, startS: Math.round(t * 1000) / 1000, endS: Math.round((t + 0.3) * 1000) / 1000 }); t += 1 / 3; }
    t += 0.4;
  }
  return out;
}
function deps(over: Partial<StageDeps> = {}): StageDeps {
  const voice = createFakeVoice();
  return { db: db.pool, root, voiceFor: async (a: { budgetScopes: string[] }) => ({ provider: voice.forScopes(a.budgetScopes), providerId: "fake", voice: "fake" }), image: createFakeImage(), renderer: createFakeRenderer({ fixture: path.resolve("tests/fixtures/video/short.mp4") }), mix: { runChild: (s: ChildSpec) => runChild(s), audioRoot: root }, qaScan: async () => ({ facts: { durationS: 1, sizeBytes: 1, video: null, audioCodec: null }, blackRuns: [], freezeRuns: [], lufs: -16, truePeakDb: -3, meanDb: -20, narrationS: null }), ...over } as unknown as StageDeps;
}
const fakeRender = async (ctx: { attemptDir: string }, input: ClipRenderInput) => {
  const outPath = path.join(ctx.attemptDir, input.outFile);
  copyFileSync(input.clipFile, outPath);
  return { ok: true as const, outPath, image: "fake-image" };
};

/** A finished source with caption words and evidence (one claim the first clip states, one it never does), and a cut batch. */
async function sourceWithBatch(): Promise<string> {
  const v = await createVideoRow(db.pool, { format: "short", kind: "tsx", language: "en", topic: "Why the sky is blue", style: "flat_motion" });
  const cap = { timings_kind: "aligned", words: words(), needs_check: false, flags: [], approximate: false };
  await addContent(db.pool, v.id, "captions", { body: cap, sha256: sha256Hex(canonicalJson(cap)) });
  const ev = { claims: [{ text: SKY, kind: "computed", method: "m" }, { text: OZONE, kind: "computed", method: "m" }] };
  await addContent(db.pool, v.id, "evidence", { body: ev, sha256: sha256Hex(canonicalJson(ev)) });
  const dir = path.join(root, "videos", v.id);
  mkdirSync(dir, { recursive: true });
  const r = spawnSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=black:s=320x180:r=10:d=95", "-f", "lavfi", "-i", "sine=frequency=330:duration=95", "-shortest", "-pix_fmt", "yuv420p", path.join(dir, "final.mp4")]);
  if (r.status !== 0) throw new Error(String(r.stderr));
  await db.pool.query("insert into stage_runs (id, video_id, name, status, input_hash) values ($1, $2, 'qa', 'succeeded', 'h')", [uuidv7(), v.id]);
  const out = await play(v.id, "clips", withAttempt({ db: db.pool, root }, clipsAttempt(deps(), { render: fakeRender })));
  if (out.kind !== "committed") throw new Error(`clips ended ${out.kind}`);
  return v.id;
}

describe("createClipShorts", () => {
  it("makes a Short per chosen clip that inherits the window's script and only the claims it states, and waits for the owner's script approval", async () => {
    const src = await sourceWithBatch();
    const r = await createClipShorts(db.pool, queue, { root, sourceVideoId: src, batch: 1, clipIds: ["c1", "c2"], sessionId: SESSION.sessionId });
    if (!r.ok) throw new Error(r.message);
    expect(r.created.map((c) => c.clipId)).toEqual(["c1", "c2"]);
    expect(r.skipped).toEqual([]);
    const child = r.created[0]!.videoId;
    const row = (await db.pool.query("select format, kind, language, style, topic, clip_of, clip_batch, clip_id, clip_start_ms, clip_end_ms, status from videos where id = $1", [child])).rows[0];
    expect(row).toMatchObject({ format: "short", kind: "tsx", language: "en", style: "flat_motion", clip_of: src, clip_batch: 1, clip_id: "c1" });
    expect(row.clip_end_ms).toBeGreaterThan(row.clip_start_ms);
    expect(statSync(path.join(root, "videos", child, "final.mp4")).size).toBeGreaterThan(1000);
    const script = (await latestContent(db.pool, child, "script"))!.body as { narration: string; title: string; evidence: { text: string }[]; beats: unknown[] };
    expect(script.narration).toContain(SKY);
    expect(script.title.length).toBeGreaterThan(3);
    expect(script.evidence.map((e) => e.text)).toEqual([SKY]); // the ozone claim is not in the clip, so it is not inherited
    expect(((await latestContent(db.pool, child, "evidence"))!.body as { claims: unknown[]; verification?: unknown }).verification).toBeUndefined();
    expect(await readNextAction(db.pool, child, approvalReaders)).toMatchObject({ kind: "wait_gate", gate: "script" }); // nothing is approved for the owner
    expect((await db.pool.query("select 1 from approvals where video_id = $1", [child])).rowCount).toBe(0);
  }, 240_000);

  it("after the owner approves the script, QA checks the clip file and the video gate opens", async () => {
    const src = await sourceWithBatch();
    const r = await createClipShorts(db.pool, queue, { root, sourceVideoId: src, batch: 1, clipIds: ["c1"] });
    if (!r.ok) throw new Error(r.message);
    const child = r.created[0]!.videoId;
    const live = await liveGateHash(db.pool, child, "script");
    const ok = await approveGate(db.pool, { videoId: child, gate: "script", seenHash: live!.hash, actor: SESSION });
    if (!ok.ok) throw new Error(ok.reason);
    queued.length = 0;
    const adv = await advanceVideo(db.pool, queue, child, approvalReaders);
    expect(adv.enqueued.length, JSON.stringify({ adv, next: await readNextAction(db.pool, child, approvalReaders) })).toBe(1);
    const qaRow = (await db.pool.query<{ id: string; input_hash: string; name: string }>("select id, input_hash, name from stage_runs where video_id = $1 and status = 'queued'", [child])).rows[0]!;
    expect(qaRow.name).toBe("qa");
    // run the run the pipeline queued (its own input hash), so the pipeline sees the stage as up to date afterwards
    const out = await runStage(db.pool, { provider: noProvider, ttlMs: 60_000, workerId: "w1", handler: withAttempt({ db: db.pool, root }, qaAttempt(deps({ qaScan: undefined }))), config: buildEngineConfig(new Map()) }, { stageRunId: qaRow.id, inputHash: qaRow.input_hash });
    expect(out.kind).toBe("committed");
    expect(await latestContent(db.pool, child, "video")).not.toBeNull();
    expect(await readNextAction(db.pool, child, approvalReaders)).toMatchObject({ kind: "wait_gate", gate: "video" });
  }, 240_000);

  it("a second request for the same clip makes nothing, and refusals are plain", async () => {
    const src = await sourceWithBatch();
    const first = await createClipShorts(db.pool, queue, { root, sourceVideoId: src, batch: 1, clipIds: ["c1"] });
    expect(first).toMatchObject({ ok: true });
    const again = await createClipShorts(db.pool, queue, { root, sourceVideoId: src, batch: 1, clipIds: ["c1"] });
    expect(again).toMatchObject({ ok: true, created: [], skipped: [{ clipId: "c1", reason: expect.stringMatching(/already made/) }] });
    expect((await db.pool.query("select count(*)::int as n from videos where clip_of = $1", [src])).rows[0].n).toBe(1);
    expect(await createClipShorts(db.pool, queue, { root, sourceVideoId: src, batch: 1, clipIds: [] })).toMatchObject({ ok: false, message: expect.stringMatching(/at least one/) });
    expect(await createClipShorts(db.pool, queue, { root, sourceVideoId: src, batch: 1, clipIds: ["c99"] })).toMatchObject({ ok: false, message: expect.stringMatching(/not in this batch/) });
    expect(await createClipShorts(db.pool, queue, { root, sourceVideoId: src, batch: 2, clipIds: ["c1"] })).toMatchObject({ ok: false, message: expect.stringMatching(/no longer the latest/) });
    expect(await createClipShorts(db.pool, queue, { root, sourceVideoId: uuidv7(), batch: 1, clipIds: ["c1"] })).toMatchObject({ ok: false, message: expect.stringMatching(/not found/) });
    await db.pool.query("update videos set status = 'cancelled' where id = $1", [src]);
    expect(await createClipShorts(db.pool, queue, { root, sourceVideoId: src, batch: 1, clipIds: ["c2"] })).toMatchObject({ ok: false, message: expect.stringMatching(/cancelled/) });
    expect(existsSync(path.join(root, "videos", src, "final.mp4"))).toBe(true); // the source is never touched
  }, 240_000);
});
