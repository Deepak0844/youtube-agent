import { copyFileSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildEngineConfig } from "@/server/core/engine-config";
import { canonicalJson, sha256Hex } from "@/server/core/content-hash";
import { uuidv7 } from "@/server/core/ids";
import type { Scan } from "@/server/core/qa-findings";
import type { StageHandler } from "@/server/core/stage-handler";
import type { StageOutcome } from "@/server/core/stage-runner";
import { requestClips } from "@/server/db/clips";
import { runStage } from "@/server/db/stage-runner-adapter";
import { insertQueuedStage } from "@/server/db/stages";
import { addContent, createVideoRow, latestContent } from "@/server/db/videos";
import { createFakeImage } from "@/server/providers/media/fake";
import { createFakeRenderer } from "@/server/providers/renderer/fake";
import type { ClipRenderInput } from "@/server/providers/renderer/clip-render";
import { createFakeVoice } from "@/server/providers/voice/fake";
import { runChild, type ChildSpec } from "@/server/render/child";
import { scanVideo } from "@/server/render/qa-scan";
import { withAttempt } from "@/worker/stages/attempt";
import { clipsAttempt, type ClipBatchBody } from "@/worker/stages/clips";
import type { StageDeps } from "@/worker/stages/deps";
import { withTestDb, type TestDb } from "../support/db";
import { assertFfprobeAvailable } from "../support/tools";

// Clip Factory CF4a: the on-demand `clips` stage cuts a batch from a finished video (real ffmpeg through the child runner), puts captions
// on each clip (a fake of the locked renderer here: it has its own real-container test), measures loudness (fake scan) and saves a
// reviewed `clip_batch`. Nothing is approved or published.

let db: TestDb;
let root: string;
beforeAll(async () => {
  assertFfprobeAvailable();
  db = await withTestDb();
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "clips-stage-")));
});
afterAll(async () => {
  rmSync(root, { recursive: true, force: true });
  await db?.stop();
});
beforeEach(async () => {
  await db.reset();
});

const noProvider = { call: async () => Promise.reject(new Error("no provider in handler mode")) };
async function play(videoId: string, handler: StageHandler): Promise<StageOutcome> {
  const inputHash = `h-clips-${uuidv7()}`;
  const stageRunId = await insertQueuedStage(db.pool, { videoId, name: "clips", inputHash });
  return runStage(db.pool, { provider: noProvider, ttlMs: 60_000, workerId: "w1", handler, config: buildEngineConfig(new Map()) }, { stageRunId, inputHash });
}

/** 20 sentences of 12 words at 3 a second with 0.4 s of silence: about 88 s of speech. */
function words() {
  const out: { word: string; startS: number; endS: number }[] = [];
  let t = 0;
  for (let s = 0; s < 20; s++) {
    for (let k = 0; k < 12; k++) { out.push({ word: k === 0 ? "Why" : k === 11 ? "end." : `w${k}`, startS: Math.round(t * 1000) / 1000, endS: Math.round((t + 0.3) * 1000) / 1000 }); t += 1 / 3; }
    t += 0.4;
  }
  return out;
}
async function finishedVideo(opts: { captions?: boolean; source?: boolean } = {}): Promise<string> {
  const v = await createVideoRow(db.pool, { format: "short", kind: "tsx", language: "en", topic: "Why the sky is blue" });
  if (opts.captions !== false) {
    const body = { timings_kind: "aligned", words: words(), needs_check: false, flags: [], approximate: false };
    await addContent(db.pool, v.id, "captions", { body, sha256: sha256Hex(canonicalJson(body)) });
  }
  if (opts.source !== false) {
    const dir = path.join(root, "videos", v.id);
    mkdirSync(dir, { recursive: true });
    const r = spawnSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=black:s=320x180:r=10:d=95", "-f", "lavfi", "-i", "sine=frequency=330:duration=95", "-shortest", "-pix_fmt", "yuv420p", path.join(dir, "final.mp4")]);
    if (r.status !== 0) throw new Error(String(r.stderr));
  }
  await db.pool.query("insert into stage_runs (id, video_id, name, status, input_hash) values ($1, $2, 'qa', 'succeeded', 'h')", [uuidv7(), v.id]);
  return v.id;
}

const scan = (lufs: number | null): Scan => ({ facts: { durationS: 1, sizeBytes: 1, video: null, audioCodec: null }, blackRuns: [], freezeRuns: [], lufs, truePeakDb: -3, meanDb: -20, narrationS: null });
function deps(over: Partial<StageDeps> = {}): StageDeps {
  const voice = createFakeVoice();
  return {
    db: db.pool, root, voiceFor: async (a: { budgetScopes: string[] }) => ({ provider: voice.forScopes(a.budgetScopes), providerId: "fake", voice: "fake" }), image: createFakeImage(), renderer: createFakeRenderer({ fixture: path.resolve("tests/fixtures/video/short.mp4") }),
    mix: { runChild: (spec: ChildSpec) => runChild(spec), audioRoot: root }, qaScan: async () => scan(-16), ...over,
  } as unknown as StageDeps;
}
/** The locked renderer's stand-in: the clip comes out as the cut clip itself (the renderer has its own real-container test). */
const fakeRender = (seen: ClipRenderInput[] = []) => async (ctx: { attemptDir: string }, input: ClipRenderInput) => {
  seen.push(input);
  const outPath = path.join(ctx.attemptDir, input.outFile);
  copyFileSync(input.clipFile, outPath);
  return { ok: true as const, outPath, image: "fake-image" };
};
const probe = (f: string) => JSON.parse(spawnSync("ffprobe", ["-v", "error", "-show_entries", "stream=width,height,codec_type:format=duration", "-of", "json", f], { encoding: "utf8" }).stdout) as { streams: { width?: number; height?: number }[]; format: { duration: string } };

describe("clips stage", () => {
  it("cuts a batch, puts captions on every clip, measures loudness and saves a reviewed clip_batch next to the source", async () => {
    const id = await finishedVideo();
    const seen: ClipRenderInput[] = [];
    const out = await play(id, withAttempt({ db: db.pool, root }, clipsAttempt(deps({ qaScan: scanVideo }), { render: fakeRender(seen) }))); // the real loudness scan
    expect(out.kind).toBe("committed");
    const body = (await latestContent(db.pool, id, "clip_batch"))!.body as ClipBatchBody;
    expect(body.sourceVideoId).toBe(id);
    expect(body.batch).toBe(1);
    expect(body.clips.length).toBeGreaterThanOrEqual(2);
    expect(Object.keys(body.measured)).toEqual(body.clips.map((c) => c.id));
    expect(body.review.clips).toHaveLength(body.clips.length);
    for (const m of Object.values(body.measured)) expect(m.lufs).not.toBeNull(); // really measured (a sine tone), not a stand-in
    expect(seen).toHaveLength(body.clips.length);
    for (const c of body.clips) {
      const file = path.join(root, "videos", id, c.file);
      expect(existsSync(file), c.file).toBe(true);
      const p = probe(file);
      expect(p.streams.find((s) => s.width)).toMatchObject({ width: 1080, height: 1920 });
      expect(Math.abs(Number(p.format.duration) - c.durationS)).toBeLessThan(0.8);
      expect(c.words[0]!.startS).toBeLessThan(0.6); // caption words were shifted to the clip
    }
    expect(existsSync(path.join(root, "videos", id, "cut-c1.mp4"))).toBe(false); // the intermediate cut is not kept
  }, 180_000);

  it("a second run is a new batch and the first batch's files stay", async () => {
    const id = await finishedVideo();
    const run = () => play(id, withAttempt({ db: db.pool, root }, clipsAttempt(deps(), { render: fakeRender() })));
    expect((await run()).kind).toBe("committed");
    const first = (await latestContent(db.pool, id, "clip_batch"))!.body as ClipBatchBody;
    expect((await run()).kind).toBe("committed");
    const second = (await latestContent(db.pool, id, "clip_batch"))!.body as ClipBatchBody;
    expect(second.batch).toBe(2);
    expect(second.clips[0]!.file).toMatch(/^clips-b2-/);
    expect(existsSync(path.join(root, "videos", id, first.clips[0]!.file))).toBe(true);
  }, 300_000);

  it("a loud or unmeasured clip stays in the batch with a warning (the owner decides)", async () => {
    const id = await finishedVideo();
    await play(id, withAttempt({ db: db.pool, root }, clipsAttempt(deps({ qaScan: async () => scan(-6) }), { render: fakeRender() })));
    const body = (await latestContent(db.pool, id, "clip_batch"))!.body as ClipBatchBody;
    expect(body.review.needAttention).toBe(body.clips.length);
    expect(body.review.clips[0]!.warnings.join(" ")).toMatch(/LUFS/);
  }, 180_000);

  it("refuses in plain words: no caption words, a failing render keeps nothing, a missing tool", async () => {
    const noCaps = await finishedVideo({ captions: false });
    const a = await play(noCaps, withAttempt({ db: db.pool, root }, clipsAttempt(deps(), { render: fakeRender() })));
    expect(a.kind).toBe("known_failure");
    expect(await latestContent(db.pool, noCaps, "clip_batch")).toBeNull();

    const id = await finishedVideo();
    const bad = async () => ({ ok: false as const, message: "The clip render failed (exit 1)." });
    const b = await play(id, withAttempt({ db: db.pool, root }, clipsAttempt(deps(), { render: bad })));
    expect(b.kind).toBe("known_failure");
    expect(await latestContent(db.pool, id, "clip_batch")).toBeNull();

    const c = await play(id, withAttempt({ db: db.pool, root }, clipsAttempt(deps({ mix: undefined }), { render: fakeRender() })));
    expect(c.kind).toBe("known_failure");
  }, 180_000);
});

describe("requestClips", () => {
  const queue = { enqueue: async () => "job" };
  it("queues one run for a finished video, refuses an unfinished or busy one, and a new request after a run makes a new hash", async () => {
    const v = await createVideoRow(db.pool, { format: "short", kind: "tsx", language: "en", topic: "t" });
    expect(await requestClips(db.pool, queue, v.id)).toMatchObject({ ok: false, message: expect.stringMatching(/finished and passed/) });
    expect(await requestClips(db.pool, queue, uuidv7())).toMatchObject({ ok: false, message: expect.stringMatching(/not found/) });
    await db.pool.query("insert into stage_runs (id, video_id, name, status, input_hash) values ($1, $2, 'qa', 'succeeded', 'h')", [uuidv7(), v.id]);
    const first = await requestClips(db.pool, queue, v.id);
    expect(first.ok).toBe(true);
    expect(await requestClips(db.pool, queue, v.id)).toMatchObject({ ok: false, message: expect.stringMatching(/already being cut/) });
    await db.pool.query("update stage_runs set status = 'succeeded' where video_id = $1 and name = 'clips'", [v.id]);
    const second = await requestClips(db.pool, queue, v.id);
    expect(second.ok).toBe(true);
    const hashes = (await db.pool.query<{ input_hash: string }>("select input_hash from stage_runs where video_id = $1 and name = 'clips' order by created_at", [v.id])).rows.map((r) => r.input_hash);
    expect(new Set(hashes).size).toBe(2);
  });
});
