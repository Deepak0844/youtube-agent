import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { canonicalJson, sha256Hex } from "@/server/core/content-hash";
import { buildEngineConfig } from "@/server/core/engine-config";
import { uuidv7 } from "@/server/core/ids";
import type { StageHandler } from "@/server/core/stage-handler";
import type { StageOutcome } from "@/server/core/stage-runner";
import { tsxDuration } from "@/server/core/tsx-check";
import { approveGate, liveGateHash } from "@/server/db/approvals";
import { runStage } from "@/server/db/stage-runner-adapter";
import { insertQueuedStage } from "@/server/db/stages";
import { addContent, createVideoRow, latestContent } from "@/server/db/videos";
import type { EngineDeps, EngineRequest, EngineResult } from "@/server/engine/run";
import { createFakeImage } from "@/server/providers/media/fake";
import { createFakeRenderer } from "@/server/providers/renderer/fake";
import type { TsxRenderer, TsxRenderResult } from "@/server/providers/renderer";
import type { TsxRendererDeps } from "@/server/providers/renderer/tsx-render";
import { createFakeVoice } from "@/server/providers/voice/fake";
import { runChild, type ChildSpec } from "@/server/render/child";
import { withAttempt } from "@/worker/stages/attempt";
import type { StageDeps } from "@/worker/stages/deps";
import { codeSceneAttempt } from "@/worker/stages/engine-build";
import { GOOD_SCENE } from "../fixtures/tsx-good-scene";
import { withTestDb, type TestDb } from "../support/db";
import { assertFfprobeAvailable } from "../support/tools";

// Long videos, L3: the code-scene step draws a long video one chapter at a time, saves each finished chapter at once, renders them in the (fake) locked
// renderer and joins them with real ffmpeg. The engine and the renderer are fakes here; their real counterparts have their own tests and the owner's real run.

let db: TestDb;
let root: string;
const SESSION = { kind: "session", sessionId: "11111111-1111-4111-8111-111111111111" } as const;
const ON = buildEngineConfig(new Map<string, unknown>([["engine.enabled", true]]));
const OFF = buildEngineConfig(new Map());

beforeAll(async () => {
  assertFfprobeAvailable();
  db = await withTestDb();
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "engine-long-")));
});
afterAll(async () => {
  rmSync(root, { recursive: true, force: true });
  await db?.stop();
});
beforeEach(async () => {
  await db.reset();
  await db.pool.query("insert into sessions (id, token_hash, expires_at, absolute_expires_at) values ($1, 'engine-long', clock_timestamp() + interval '1 day', clock_timestamp() + interval '7 days') on conflict (id) do nothing", [SESSION.sessionId]);
});

const noProvider = { call: async () => Promise.reject(new Error("no provider in handler mode")) };
async function play(videoId: string, handler: StageHandler, config = ON): Promise<StageOutcome> {
  const inputHash = `h-tsx_author-${uuidv7()}`;
  const stageRunId = await insertQueuedStage(db.pool, { videoId, name: "tsx_author", inputHash });
  return runStage(db.pool, { provider: noProvider, ttlMs: 60_000, workerId: "w1", handler, config }, { stageRunId, inputHash });
}
const reason = async (out: StageOutcome) => JSON.stringify((await db.pool.query("select result from stage_runs where id = $1", [(out as { claim: { stageRunId: string } }).claim.stageRunId])).rows[0]?.result ?? {});

/** Five chapters; `per` beats of 10 words (3 words a second) in each. The beats are named c1_b1 ... like the engine's long script. */
async function longVideo(per = [8, 9, 10, 9, 8], opts: { outline?: boolean } = {}): Promise<{ id: string; narrationS: number; frames: number[] }> {
  const v = await createVideoRow(db.pool, { format: "long", kind: "tsx", language: "en", topic: "How DNS works", lengthMinMinutes: 3, lengthMaxMinutes: 4 } as never);
  const outline = { chapters: per.map((_, i) => ({ title: `Chapter ${i + 1}`, line: `what chapter ${i + 1} teaches`, target_s: 30 })), length: { min_minutes: 3, max_minutes: 4 } };
  await addContent(db.pool, v.id, "outline", { body: outline, sha256: sha256Hex(canonicalJson(outline)) });
  const beats: { id: string; text: string; visual: string }[] = [];
  const words: { word: string; startS: number; endS: number }[] = [];
  let t = 0;
  per.forEach((count, c) => {
    for (let b = 0; b < count; b++) {
      const text = Array.from({ length: 10 }, (_, k) => `w${c + 1}x${b + 1}x${k}`).join(" ");
      beats.push({ id: `c${c + 1}_b${b + 1}`, text, visual: `picture ${c + 1}.${b + 1}` });
      for (const w of text.split(" ")) { words.push({ word: w, startS: Math.round(t * 1000) / 1000, endS: Math.round((t + 0.3) * 1000) / 1000 }); t += 1 / 3; }
    }
  });
  const script = { title: "DNS", narration: beats.map((b) => b.text).join(" "), beats, evidence: [{ text: "2 + 2 = 4", kind: "computed", method: "add" }] };
  await addContent(db.pool, v.id, "script", { body: script, sha256: sha256Hex(canonicalJson(script)) });
  await addContent(db.pool, v.id, "beats", { body: { beats }, sha256: sha256Hex(canonicalJson({ beats })) });
  const caps = { timings_kind: "aligned", words, needs_check: false, flags: [], approximate: false };
  await addContent(db.pool, v.id, "captions", { body: caps, sha256: sha256Hex(canonicalJson(caps)) });
  mkdirSync(path.join(root, "videos", v.id), { recursive: true });
  writeFileSync(path.join(root, "videos", v.id, "narration.wav"), "not a real wav: the narration length is a test seam");
  const nar = { file: "narration.wav" };
  await addContent(db.pool, v.id, "narration", { body: nar, sha256: sha256Hex(canonicalJson(nar)) });
  if (opts.outline !== false) {
    const lo = await liveGateHash(db.pool, v.id, "outline");
    const a = await approveGate(db.pool, { videoId: v.id, gate: "outline", seenHash: lo!.hash, actor: SESSION });
    if (!a.ok) throw new Error(a.reason);
  }
  const ls = await liveGateHash(db.pool, v.id, "script");
  const b = await approveGate(db.pool, { videoId: v.id, gate: "script", seenHash: ls!.hash, actor: SESSION });
  if (!b.ok) throw new Error(b.reason);
  const frames = per.map((n) => Math.round((n * 10) / 3 * 30)); // approximate; the real numbers come from the prompts
  return { id: v.id, narrationS: t, frames };
}

const landscape = (frames: number) => GOOD_SCENE.replace("durationInFrames: 270", `durationInFrames: ${frames}`).replace("width: 1080, height: 1920", "width: 1920, height: 1080");

/** A scripted engine: for each chapter it reads the frames and the file name from the prompt it was given. `skip` chapters write nothing; `wrongFrames` write the wrong length. */
function fakeEngine(o: { skip?: number[]; wrongFrames?: number[]; limitAt?: number } = {}) {
  const calls: Array<{ chapter: number; frames: number; file: string; req: EngineRequest }> = [];
  const run = async (_deps: EngineDeps, req: EngineRequest): Promise<EngineResult> => {
    const frames = Number(/durationInFrames: (\d+)/.exec(req.prompt)![1]);
    const file = /Write one file, (scene\/ch\d+\.tsx)/.exec(req.prompt)![1]!;
    const chapter = Number(/chapter (\d+) of/i.exec(req.prompt)![1]);
    calls.push({ chapter, frames, file, req });
    if (o.limitAt === chapter) return { ok: false, limit: true, resumeAt: new Date("2026-11-20T10:00:00Z") };
    const workDir = mkdtempSync(path.join(root, "work-"));
    if (!o.skip?.includes(chapter)) {
      mkdirSync(path.join(workDir, "scene"), { recursive: true });
      writeFileSync(path.join(workDir, file), landscape(o.wrongFrames?.includes(chapter) ? frames + 30 : frames));
    }
    return { ok: true, text: "done", usage: { inputTokens: 1, outputTokens: 1, costUsdEquiv: 0 } as never, turns: 10, workDir };
  };
  return { run, calls };
}

/** The locked renderer's stand-in: a REAL mp4 of exactly the chapter's frames (same codec settings every time, so the join can copy streams). */
function fakeTsx(): TsxRenderer & { sources: string[]; failFor?: string } {
  const sources: string[] = [];
  const self: TsxRenderer & { sources: string[]; failFor?: string } = {
    sources,
    async renderTsx(ctx, input): Promise<TsxRenderResult> {
      sources.push(input.source);
      if (self.failFor && input.outFile === self.failFor) return { ok: false, error: { kind: "render", message: "The render failed.", problems: [] } };
      const frames = tsxDuration(input.source)!;
      const outPath = path.join(ctx.attemptDir, input.outFile);
      const r = spawnSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", `testsrc2=size=320x180:rate=30:duration=${frames / 30}`, "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", outPath]);
      if (r.status !== 0) throw new Error(String(r.stderr));
      const stills = ["tsx-frame-first.png", "tsx-frame-middle.png", "tsx-frame-last.png"];
      for (const s of stills) writeFileSync(path.join(ctx.attemptDir, s), "png");
      return { ok: true, outPath, image: "fake-image", stills };
    },
  };
  return self;
}
const render = { kitDir: "/k", runChild: async () => ({ code: 0, signal: null, truncated: false, timedOut: false, aborted: false }), probe: async () => ({}) } as unknown as TsxRendererDeps;
function mkDeps(tsx: TsxRenderer, narrationS: number): { deps: StageDeps; e: Parameters<typeof codeSceneAttempt>[1] } {
  const voice = createFakeVoice();
  const deps = { db: db.pool, root, voiceFor: async (a: { budgetScopes: string[] }) => ({ provider: voice.forScopes(a.budgetScopes), providerId: "fake", voice: "fake" }), image: createFakeImage(), renderer: createFakeRenderer({ fixture: path.resolve("tests/fixtures/video/short.mp4") }), tsx, mix: { runChild: (s: ChildSpec) => runChild(s), audioRoot: root } } as unknown as StageDeps;
  return { deps, e: { root: path.join(root, "engine"), render, narrationSeconds: async () => narrationS } };
}
const probeS = (f: string) => Number(spawnSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", f], { encoding: "utf8" }).stdout);

describe("long video code-scene step", () => {
  it("draws each chapter in its own run, gives chapter 1's file to the later ones as the look, joins the chapters and saves every chapter at once", async () => {
    const v = await longVideo();
    const eng = fakeEngine();
    const tsx = fakeTsx();
    const { deps, e } = mkDeps(tsx, v.narrationS);
    const out = await play(v.id, withAttempt({ db: db.pool, root }, codeSceneAttempt(deps, { ...e, runEngine: eng.run })));
    expect(out.kind, await reason(out)).toBe("committed");
    expect(eng.calls.map((c) => [c.chapter, c.file])).toEqual([[1, "scene/ch01.tsx"], [2, "scene/ch02.tsx"], [3, "scene/ch03.tsx"], [4, "scene/ch04.tsx"], [5, "scene/ch05.tsx"]]);
    expect(eng.calls.every((c) => c.req.kind === "build" && c.req.long === false)).toBe(true);
    expect(Object.keys(eng.calls[0]!.req.inputs ?? {}).sort()).toEqual(["script.json", "words.json"]);
    for (const c of eng.calls.slice(1)) expect(Object.keys(c.req.inputs ?? {}).sort()).toEqual(["look-ch01.txt", "script.json", "words.json"]);
    expect(eng.calls[1]!.req.inputs!["look-ch01.txt"]).toBe(landscape(eng.calls[0]!.frames)); // chapter 1's accepted file
    // each chapter has its own share of the frames, and together they are the whole narration (plus the tail), with no drift
    const total = eng.calls.reduce((a, c) => a + c.frames, 0);
    expect(total).toBe(Math.ceil((v.narrationS + 0.4) * 30 - 1e-9));
    expect(total).toBeGreaterThan(2700); // longer than ONE code scene may be: that limit is per chapter
    expect(tsx.sources).toHaveLength(5);
    // all five chapters are saved as content, and the joined video is as long as the narration
    const saved = (await db.pool.query("select body->>'index' as i from video_content where video_id = $1 and kind = 'chapter_scene' order by 1", [v.id])).rows.map((r) => r.i);
    expect(saved).toEqual(["1", "2", "3", "4", "5"]);
    expect(Math.abs(probeS(path.join(root, "videos", v.id, "render.mp4")) - total / 30)).toBeLessThan(1);
    const body = (await latestContent(db.pool, v.id, "tsx"))!.body as { chapters: { index: number; frames: number }[]; durationInFrames: number; orientation: string };
    expect(body.chapters.map((c) => c.index)).toEqual([1, 2, 3, 4, 5]);
    expect(body).toMatchObject({ durationInFrames: total, orientation: "landscape" });
    const stored = (await db.pool.query("select result from stage_runs where video_id = $1 and name = 'tsx_author'", [v.id])).rows[0]!.result as { chapters: number; drawnNow: number; keptFromBefore: number };
    expect(stored).toMatchObject({ chapters: 5, drawnNow: 5, keptFromBefore: 0 });
  }, 300_000);

  it("a chapter that fails keeps the finished ones: the next try draws only the missing chapters", async () => {
    const v = await longVideo();
    const { deps, e } = mkDeps(fakeTsx(), v.narrationS);
    const first = fakeEngine({ skip: [3] }); // chapter 3: the engine writes no file
    const out = await play(v.id, withAttempt({ db: db.pool, root }, codeSceneAttempt(deps, { ...e, runEngine: first.run })));
    expect(out.kind).toBe("known_failure");
    expect(await reason(out)).toMatch(/did not write scene\/ch03\.tsx/);
    expect(first.calls.map((c) => c.chapter)).toEqual([1, 2, 3]); // it stopped at chapter 3
    expect((await db.pool.query("select count(*)::int n from video_content where video_id = $1 and kind = 'chapter_scene'", [v.id])).rows[0].n).toBe(2);
    expect(await latestContent(db.pool, v.id, "tsx")).toBeNull(); // nothing half-finished is saved as the video

    const second = fakeEngine();
    const tsx2 = fakeTsx();
    const again = await play(v.id, withAttempt({ db: db.pool, root }, codeSceneAttempt(mkDeps(tsx2, v.narrationS).deps, { ...e, runEngine: second.run })));
    expect(again.kind, await reason(again)).toBe("committed");
    expect(second.calls.map((c) => c.chapter)).toEqual([3, 4, 5]); // chapters 1 and 2 were kept, not drawn again
    expect(second.calls[0]!.req.inputs!["look-ch01.txt"]).toBeDefined(); // the kept chapter 1 is still the look
    expect(tsx2.sources).toHaveLength(5); // every chapter is rendered again (cheap) so the join has all five
    const stored = (await db.pool.query("select result from stage_runs where id = $1", [(again as { claim: { stageRunId: string } }).claim.stageRunId])).rows[0]!.result as { drawnNow: number; keptFromBefore: number };
    expect(stored).toMatchObject({ drawnNow: 3, keptFromBefore: 2 });
  }, 300_000);

  it("refuses a chapter file of the wrong length, a chapter that does not render, and a usage limit pauses with the finished chapters kept", async () => {
    const v = await longVideo();
    const { deps, e } = mkDeps(fakeTsx(), v.narrationS);
    const wrong = await play(v.id, withAttempt({ db: db.pool, root }, codeSceneAttempt(deps, { ...e, runEngine: fakeEngine({ wrongFrames: [2] }).run })));
    expect(wrong.kind).toBe("known_failure");
    expect(await reason(wrong)).toMatch(/Chapter 2 of 5: the scene file is \d+ frames; meta\.durationInFrames must be \d+/);

    const v2 = await longVideo();
    const bad = fakeTsx();
    bad.failFor = "ch02.mp4";
    const noRender = await play(v2.id, withAttempt({ db: db.pool, root }, codeSceneAttempt(mkDeps(bad, v2.narrationS).deps, { ...e, runEngine: fakeEngine().run })));
    expect(noRender.kind).toBe("known_failure");
    expect(await reason(noRender)).toMatch(/Chapter 2 of 5 did not render: The render failed\./);
    expect((await db.pool.query("select count(*)::int n from video_content where video_id = $1 and kind = 'chapter_scene'", [v2.id])).rows[0].n).toBe(2); // chapter 2 was drawn and checked, so it is kept for the retry

    const v3 = await longVideo();
    const limited = await play(v3.id, withAttempt({ db: db.pool, root }, codeSceneAttempt(mkDeps(fakeTsx(), v3.narrationS).deps, { ...e, runEngine: fakeEngine({ limitAt: 3 }).run })));
    expect(await reason(limited)).toMatch(/Claude limit reached\. This step resumes about .* IST by itself\./);
    expect((await db.pool.query("select count(*)::int n from video_content where video_id = $1 and kind = 'chapter_scene'", [v3.id])).rows[0].n).toBe(2);
  }, 300_000);

  it("refuses in plain words: outline not approved, the engine off for a long video, a chapter over 90 s, and beats that do not follow the chapters", async () => {
    const eng = fakeEngine();
    const noOutline = await longVideo([8, 9, 10, 9, 8], { outline: false });
    const { deps: d0, e: e0 } = mkDeps(fakeTsx(), noOutline.narrationS);
    const a = await play(noOutline.id, withAttempt({ db: db.pool, root }, codeSceneAttempt(d0, { ...e0, runEngine: eng.run })));
    expect(a.kind).toBe("known_failure");
    expect(await reason(a)).toMatch(/outline is not approved/);
    const ok = await longVideo();
    const { deps, e } = mkDeps(fakeTsx(), ok.narrationS);
    const off = await play(ok.id, withAttempt({ db: db.pool, root }, codeSceneAttempt(deps, { ...e, runEngine: eng.run })), OFF);
    expect(off.kind).toBe("known_failure");
    expect(await reason(off)).toMatch(/A long video is drawn by the engine/);

    const longChapter = await longVideo([8, 9, 10, 9, 40]); // chapter 5 is 40 beats = 133 s
    const lc = mkDeps(fakeTsx(), longChapter.narrationS);
    const tooLong = await play(longChapter.id, withAttempt({ db: db.pool, root }, codeSceneAttempt(lc.deps, { ...lc.e, runEngine: eng.run })));
    expect(tooLong.kind, await reason(tooLong)).toBe("known_failure");
    expect(await reason(tooLong)).toMatch(/Chapter 5 is 13\d(\.\d+)? seconds long; one code scene may run at most 90 seconds/);
    expect(eng.calls).toHaveLength(0); // refused before any engine run

  }, 300_000);
});
