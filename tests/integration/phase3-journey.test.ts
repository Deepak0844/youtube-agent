// Phase 3 exit proof (Task 21): voice, sound and mix for a real beats file in English, Hindi and Tamil on fake providers and
// real ffmpeg, plus a kill at every paid step of the new stages. A "kill" here is an in-process Died thrown at the exact point
// (the real SIGKILL sweep over tts/generate is engine-chaos / engine-resilience); the next attempt is the same stage run with a
// higher fence after the lost attempt folder was swept, which is what a restarted worker does.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { CaptionsBody } from "@/server/core/alignment";
import { canonicalJson, sha256Hex } from "@/server/core/content-hash";
import { buildEngineConfig } from "@/server/core/engine-config";
import { uuidv7 } from "@/server/core/ids";
import type { Lang } from "@/server/core/lang";
import { NeedsDecisionError, type PaidCallPorts } from "@/server/core/paid-call";
import { createStageContext } from "@/server/core/stage-handler";
import { approveGate, CAPTIONS_REASON, liveGateHash } from "@/server/db/approvals";
import { addAudioItem } from "@/server/db/audio-library";
import { createPgPaidCallPorts } from "@/server/db/paid-call-adapter";
import { tickCaptions } from "@/server/db/queue-actions";
import { runStage } from "@/server/db/stage-runner-adapter";
import { claimStage, insertQueuedStage } from "@/server/db/stages";
import { addContent, createVideoRow, latestContent } from "@/server/db/videos";
import { ok, throwsUnknown } from "@/server/providers/fake-base";
import { createFalImage } from "@/server/providers/image/fal";
import { createOpenAIImage } from "@/server/providers/image/openai";
import { createFakeImage } from "@/server/providers/media/fake";
import { ensureSound, type SoundDeps, type SoundNeed } from "@/server/providers/sound";
import { createElevenLabsSound } from "@/server/providers/sound/elevenlabs";
import { createFakeVoice, type FakeVoiceOptions } from "@/server/providers/voice/fake";
import type { SafeFetch } from "@/server/providers/voice/eleven-types";
import { parseWav, wavSeconds } from "@/server/providers/voice/wav";
import { runChild, type ChildSpec } from "@/server/render/child";
import { sweepLostAttempts } from "@/server/storage/store";
import { prepareAttempt, withAttempt } from "@/worker/stages/attempt";
import { contentBody, type StageDeps } from "@/worker/stages/deps";
import { sfxHandler } from "@/worker/stages/sfx";
import { ttsAttempt } from "@/worker/stages/tts";
import { voiceAttempt } from "@/worker/stages/voice";
import { whisperAligner } from "@/worker/stages/voice-for";
import { ensureCapScope } from "@/server/db/budget-scopes";
import { withTestDb, type TestDb } from "../support/db";
import { assertFfprobeAvailable } from "../support/tools";

let db: TestDb;
let root: string;
let audioRoot: string;
let mp3: Buffer;
const config = buildEngineConfig(new Map());
const SESSION = { kind: "session", sessionId: "11111111-1111-4111-8111-111111111111" } as const;
const noProvider = { call: async () => Promise.reject(new Error("no provider")) };
const ff = (...a: string[]) => execFileSync("ffmpeg", ["-nostdin", "-v", "error", "-y", ...a]);
const peak = (file: string) => Number(/max_volume:\s*(-?[\d.]+)/.exec(spawnSync("ffmpeg", ["-nostdin", "-hide_banner", "-i", file, "-af", "volumedetect", "-f", "null", "-"], { encoding: "utf8" }).stderr)![1]);
const mix = () => ({ runChild: (s: ChildSpec) => runChild(s), audioRoot });

beforeAll(async () => {
  assertFfprobeAvailable();
  db = await withTestDb();
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "p3-journey-")));
  audioRoot = path.join(root, "audio");
  mkdirSync(audioRoot);
  ff("-f", "lavfi", "-i", "sine=f=1000:d=1", "-af", "volume=15dB", path.join(audioRoot, "loud.wav"));
  mp3 = execFileSync("ffmpeg", ["-nostdin", "-v", "error", "-f", "lavfi", "-i", "sine=f=440:d=1", "-c:a", "libmp3lame", "-b:a", "64k", "-f", "mp3", "-"], { maxBuffer: 1 << 24 });
}, 120_000);
afterAll(async () => {
  rmSync(root, { recursive: true, force: true });
  await db?.stop();
});
beforeEach(async () => {
  rmSync(path.join(audioRoot, "generated"), { recursive: true, force: true }); // a raw clip left by an earlier test would hide a lost paid clip
  await db.reset();
  await db.pool.query("insert into budgets (scope, cap_micro_usd) values ('draft_run', 3000000), ('video:scene_kit', 2000000), ('day', 15000000), ('month', 100000000)");
});

// --- helpers -------------------------------------------------------------------------------------------------------------

type Beats = { title: string; beats: Array<{ id: string; text: string }> };
const beatsOf = (l: string): Beats => JSON.parse(readFileSync(path.join(process.cwd(), "tests/fixtures/phase3", `beats-${l}.json`), "utf8")) as Beats;
const narrationOf = (b: Beats) => b.beats.map((x) => x.text).join(" ");
const THREE = ["en", "hi", "ta"] as const;

async function setScript(id: string, b: Beats) {
  const script = { title: b.title, narration: narrationOf(b) };
  await addContent(db.pool, id, "script", { body: script, sha256: sha256Hex(canonicalJson(script)) });
  const beats = { beats: b.beats };
  await addContent(db.pool, id, "beats", { body: beats, sha256: sha256Hex(canonicalJson(beats)) });
  const live = await liveGateHash(db.pool, id, "script");
  const r = await approveGate(db.pool, { videoId: id, gate: "script", seenHash: live!.hash, actor: SESSION });
  if (!r.ok) throw new Error(r.reason);
}
async function video(lang: Lang, b: Beats = beatsOf(lang)) {
  const v = await createVideoRow(db.pool, { format: "short", kind: "scene_kit", language: lang, topic: "t" });
  await setScript(v.id, b);
  return v;
}
const opts = (o: FakeVoiceOptions = {}): FakeVoiceOptions => ({ pool: db.pool, ...o });
type Fake = ReturnType<typeof createFakeVoice>;
/** Aligner stand-in: spreads the script evenly over the chunk, as the estimate would, but reported as recognised. */
const spreadAlign: NonNullable<StageDeps["align"]> = async (a) => ({
  timings_kind: "aligned", needs_check: false, flags: [], approximate: false,
  words: a.script.map((word, i) => ({ word, startS: (i * a.durationS) / a.script.length, endS: ((i + 1) * a.durationS) / a.script.length, source: "recognised" as const, flags: [] })),
});
function deps(fake: Fake, over: Partial<StageDeps> = {}): StageDeps {
  return { db: db.pool, root, mix: mix(), voiceFor: async (a) => ({ provider: fake.forScopes(a.budgetScopes), providerId: "fake", voice: "fake" }), image: {} as never, renderer: {} as never, ...over } as StageDeps;
}
async function run(id: string, handler: ReturnType<typeof withAttempt>, name = "tts") {
  const inputHash = `h-${uuidv7()}`;
  const stageRunId = await insertQueuedStage(db.pool, { videoId: id, name, inputHash });
  return runStage(db.pool, { provider: noProvider, ttlMs: 60_000, workerId: "w1", handler, config }, { stageRunId, inputHash });
}
const runTts = (id: string, d: StageDeps) => run(id, withAttempt({ db: db.pool, root }, ttsAttempt(d)));
const spent = async (id: string) => Number((await db.pool.query("select spent_micro_usd s from budgets where scope = $1", [`video:${id}`])).rows[0]?.s ?? 0);
const intentRows = async (status?: string) => Number((await db.pool.query(`select count(*) n from spend_intents ${status ? "where status = $1" : ""}`, status ? [status] : [])).rows[0].n);
const captionsOf = async (id: string) => (await latestContent(db.pool, id, "captions"))!.body as CaptionsBody;
const narrationSeconds = async (id: string) => wavSeconds(parseWav(readFileSync(path.join(root, "videos", id, (await contentBody<{ file: string }>(db.pool, id, "narration")).file))));

/** Word times are in order and cover the audio: first word within 150 ms of the start, last word within 150 ms of the end. */
function expectMonotoneAndCovering(c: CaptionsBody, audioS: number) {
  expect(c.words.length).toBeGreaterThan(0);
  let prev = -1;
  for (const w of c.words) {
    expect(w.endS).toBeGreaterThanOrEqual(w.startS);
    expect(w.startS).toBeGreaterThanOrEqual(prev);
    prev = w.startS;
  }
  expect(c.words[0]!.startS).toBeLessThanOrEqual(0.15);
  expect(Math.abs(c.words.at(-1)!.endS - audioS)).toBeLessThanOrEqual(0.15);
}

// A claimed stage ctx on a real paid-call port set; `ports` lets a test kill the worker at an exact point.
const ids = new Map<string, string>();
async function newStage(videoId: string, name: string, hash = "h") {
  const id = await insertQueuedStage(db.pool, { videoId, name, inputHash: hash });
  ids.set(id, videoId);
  return id;
}
async function claimCtx(stageId: string, name: string, hash: string, worker: string, ports: PaidCallPorts = createPgPaidCallPorts(db.pool)) {
  const claim = (await claimStage(db.pool, { id: stageId, inputHash: hash, workerId: worker, ttlMs: 600_000 }))!;
  const ctx = createStageContext({ stage: { id: stageId, name, inputHash: hash, videoId: ids.get(stageId)! }, claim, config, signal: new AbortController().signal, paid: ports }).ctx;
  await prepareAttempt(ctx, root);
  return ctx;
}
/** The worker died: the stage is handed on (higher fence) and the lost attempt's folder is swept. */
async function takeOver(stageId: string, name: string, hash: string) {
  await db.ownerPool.query("update stage_runs set status='queued', lease_owner=null, lease_until=null where id=$1", [stageId]);
  const ctx = await claimCtx(stageId, name, hash, "w2");
  expect(ctx.claim.fence).toBe(2);
  expect(await sweepLostAttempts(db.pool, { root })).toBeGreaterThanOrEqual(1);
  return ctx;
}

class Died extends Error {}
type Point = "a" | "b" | "c" | "d";
/** a = before the reserve, c = after the provider returned and before settle, d = after settle. (b, the provider call itself, is a scripted unknown outcome in the fake.) */
function dyingPorts(point: Exclude<Point, "b">, nth: number): PaidCallPorts {
  const base = createPgPaidCallPorts(db.pool);
  let reserves = 0;
  let settles = 0;
  return {
    ...base,
    async reserve(claim, args) {
      if (point === "a" && reserves++ === nth) throw new Died("before reserve");
      return base.reserve(claim, args);
    },
    async settle(intentId, args) {
      const n = settles++;
      if (point === "c" && n === nth) throw new Died("before settle");
      await base.settle(intentId, args);
      if (point === "d" && n === nth) throw new Died("after settle");
    },
  };
}
const POINTS: Point[] = ["a", "b", "c", "d"];
const portsFor = (p: Point, nth: number) => (p === "b" ? createPgPaidCallPorts(db.pool) : dyingPorts(p, nth));

// --- the journey ---------------------------------------------------------------------------------------------------------

/** tts (voice lines, captions) -> a render -> voice mux -> a sound plan with a library cue and a generated cue -> ready for the mix. */
async function produce(lang: Lang, timings: "native" | "aligned") {
  const fake = createFakeVoice(opts({ timings }));
  const d = deps(fake, timings === "aligned" ? { align: spreadAlign } : {});
  const v = await video(lang);
  expect((await runTts(v.id, d)).kind).toBe("committed");
  const dir = path.join(root, "videos", v.id);
  const audioS = await narrationSeconds(v.id);
  // The fake voice is silent and the mixer refuses cues that are too loud for a silent gap: make the narration a quiet tone of the same length.
  ff("-f", "lavfi", "-i", `sine=f=220:d=${audioS.toFixed(3)}`, "-af", "volume=-17dB", "-ar", "8000", path.join(dir, "narration.wav"));
  ff("-f", "lavfi", "-i", `color=c=black:s=64x64:r=10:d=${audioS.toFixed(3)}`, "-an", "-pix_fmt", "yuv420p", path.join(dir, "render.mp4"));
  expect((await run(v.id, withAttempt({ db: db.pool, root }, voiceAttempt(d)), "voice")).kind).toBe("committed");
  // The sound plan: one library clip, one clip generated through the paid adapter (fake mp3 over a fake fetch).
  const lib = await addAudioItem(db.pool, { kind: "sfx", name: "loud", tags: [], source: "owned", licence: "own", provenance: {}, filePath: "loud.wav", sha256: "b".repeat(64), durationS: 1, meanLufs: -6, peakDbfs: -3 });
  const hits = { n: 0 };
  const gen = await generateSound(v.id, hits);
  const cue = (id: string, itemId: string, atS: number) => ({ id, itemId, atS, gainDb: 6, optional: false });
  writeFileSync(path.join(dir, "sfx-plan.json"), JSON.stringify({ version: 1, cues: [cue("lib", lib.id, 0.5), cue("gen", gen.id, 1.5)] }));
  return { v, d, fake, dir, audioS, lib, gen, hits };
}
const elevenFetch = (hits: { n: number }, failFirst = false): SafeFetch => async () => {
  if (failFirst && hits.n++ === 0) throw new TypeError("socket hang up");
  if (!failFirst) hits.n++;
  return new Response(new Uint8Array(mp3), { status: 200, headers: { "content-type": "audio/mpeg" } });
};
async function soundDeps(videoId: string, hits: { n: number }, failFirst = false): Promise<SoundDeps> {
  const scope = await ensureCapScope(db.pool, `t21:sound:${videoId}`, 1_000_000);
  const provider = createElevenLabsSound({ fetch: elevenFetch(hits, failFirst), getKey: async () => "k", sfxPrice: { unit: "per_second", microUsd: 2000 }, musicPrice: null, budgetScopes: [scope] });
  return { db: db.pool, provider, runChild: (s) => runChild(s), audioRoot, generateAllowed: true };
}
const need: SoundNeed = { kind: "sfx", prompt: "a soft whoosh", tags: ["whoosh"], seconds: 2 };
async function generateSound(videoId: string, hits: { n: number }) {
  const sid = await newStage(videoId, "sfx", "plan");
  return ensureSound(await claimCtx(sid, "sfx", "plan", "w1"), await soundDeps(videoId, hits), need);
}
async function mixStage(p: Awaited<ReturnType<typeof produce>>, d: StageDeps = p.d) {
  return run(p.v.id, sfxHandler({ db: db.pool, root }, d), "sfx");
}

describe.each(THREE)("journey in %s", (lang) => {
  it.each(["native", "aligned"] as const)("%s word times: monotone, covering the audio, no check needed; the mix stays under the ceiling", async (timings) => {
    const p = await produce(lang, timings);
    const c = await captionsOf(p.v.id);
    expect(c.timings_kind).toBe(timings);
    expect(c.approximate).toBe(false);
    expect(c.needs_check).toBe(false);
    expectMonotoneAndCovering(c, p.audioS);
    expect(p.gen).toMatchObject({ source: "generated", kind: "sfx" });
    expect(p.hits.n).toBe(1);
    expect((await mixStage(p)).kind).toBe("committed");
    const final = path.join(p.dir, "final.mp4");
    expect(peak(final)).toBeLessThanOrEqual(-1.4);
    const used = (await db.pool.query<{ id: string; used_in: string[] }>("select id, used_in from audio_items")).rows;
    for (const item of [p.lib, p.gen]) expect(used.find((u) => u.id === item.id)!.used_in).toEqual([p.v.id]); // the generated cue and the library cue both made it into the mix
  }, 120_000);
});

describe("a rewritten line", () => {
  const REWRITE = {
    en: "Two of them push blood through the gills.",
    hi: "दो दिल खून को गलफड़ों तक भेजते हैं।",
    ta: "இரண்டு இதயங்கள் இரத்தத்தை செவுள்களுக்கு செலுத்துகின்றன.",
  } as const;
  it("one_rewritten_line_is_the_only_line_billed_in_en_hi_ta", async () => {
    for (const lang of THREE) {
      const fake = createFakeVoice(opts());
      const d = deps(fake);
      const b = beatsOf(lang);
      const v = await video(lang, b);
      expect((await runTts(v.id, d)).kind).toBe("committed");
      expect([fake.totalCalls(), await spent(v.id)]).toEqual([4, 4000]);
      const edited = { ...b, beats: b.beats.map((x, i) => (i === 1 ? { ...x, text: REWRITE[lang] } : x)) };
      expect(narrationOf(edited)).not.toBe(narrationOf(b));
      await setScript(v.id, edited);
      expect((await runTts(v.id, d)).kind).toBe("committed");
      expect([lang, fake.totalCalls(), await spent(v.id)]).toEqual([lang, 5, 5000]); // exactly one more line paid
    }
  }, 120_000);
});

describe("languages without word-time support", () => {
  it("te_kn_ml_are_native_with_native_timings_and_flagged_approximate_when_aligned", async () => {
    const TEXT = { te: "అ ఆ ఇ. ఈ ఉ ఊ.", kn: "ಅ ಆ ಇ. ಈ ಉ ಊ.", ml: "അ ആ ഇ. ഈ ഉ ഊ." } as const;
    for (const lang of ["te", "kn", "ml"] as const) {
      const b = { title: "T", beats: [{ id: "b1", text: TEXT[lang] }] };
      const native = await video(lang, b);
      await runTts(native.id, deps(createFakeVoice(opts({ timings: "native" }))));
      expect([lang, (await captionsOf(native.id)).timings_kind]).toEqual([lang, "native"]);
      const aligned = await video(lang, b);
      const f = createFakeVoice(opts({ timings: "aligned" }));
      // another provider id: lines are cached per provider, and the native run's cached line would bring its native times
      await runTts(aligned.id, deps(f, { align: spreadAlign, voiceFor: async (a) => ({ provider: f.forScopes(a.budgetScopes), providerId: "fake-aligned", voice: "fake" }) }));
      const c = await captionsOf(aligned.id);
      expect([lang, c.approximate, c.needs_check, c.flags.includes("language_unreliable")]).toEqual([lang, true, true, true]);
    }
  });
});

describe("the video gate for approximate captions", () => {
  it("hi_and_ta_estimated_captions_refuse_the_video_gate_until_the_tick", async () => {
    for (const lang of ["hi", "ta"] as const) {
      const v = await video(lang);
      await runTts(v.id, deps(createFakeVoice(opts({ timings: "aligned" })))); // no aligner: estimated
      const c = await captionsOf(v.id);
      expect([lang, c.timings_kind, c.approximate, c.needs_check]).toEqual([lang, "estimated", true, true]);
      await addContent(db.pool, v.id, "video", { filePath: "x.mp4", sha256: "a".repeat(64) });
      await db.pool.query("update videos set status = 'active' where id = $1", [v.id]);
      const seen = (await liveGateHash(db.pool, v.id, "video"))!;
      expect(await approveGate(db.pool, { videoId: v.id, gate: "video", seenHash: seen.hash, actor: SESSION })).toEqual({ ok: false, reason: CAPTIONS_REASON });
      const t = await tickCaptions(db.pool, v.id, SESSION, true, { captionsId: seen.versions.captions?.id, videoId: seen.versions.video?.id });
      if (!t.ok) throw new Error(t.message);
      expect((await approveGate(db.pool, { videoId: v.id, gate: "video", seenHash: t.hash ?? (await liveGateHash(db.pool, v.id, "video"))!.hash, actor: SESSION })).ok).toBe(true);
    }
  });
});

describe.skipIf(!process.env.WHISPER_MODEL)("real whisper (WHISPER_MODEL is set)", () => {
  it.each(THREE)("%s: the real aligner gives monotone timings or the captions are flagged approximate", async (lang) => {
    // The fake voice is silent, so whisper may recognise nothing: that must fall back to flagged estimates, never to invented exact times.
    const v = await video(lang);
    await runTts(v.id, deps(createFakeVoice(opts({ timings: "aligned" })), { align: whisperAligner((s) => runChild(s)) }));
    const c = await captionsOf(v.id);
    if (c.timings_kind === "aligned") expectMonotoneAndCovering(c, await narrationSeconds(v.id));
    else expect([c.timings_kind, c.approximate, c.needs_check]).toEqual(["estimated", true, true]);
  }, 300_000);
});

describe("spending caps on the voice stage", () => {
  const setCap = (scope: string, cap: number | null) => db.ownerPool.query("update budgets set cap_micro_usd = $2 where scope = $1", [scope, cap]);
  it("no_limit_pays_every_line", async () => {
    await setCap("video:scene_kit", null);
    const fake = createFakeVoice(opts());
    const v = await video("en");
    expect((await runTts(v.id, deps(fake))).kind).toBe("committed");
    expect([fake.totalCalls(), await spent(v.id)]).toEqual([4, 4000]);
  });
  it("a_number_stops_before_the_line_that_would_pass_it_and_a_raised_cap_pays_only_the_rest", async () => {
    await setCap("video:scene_kit", 2500);
    const fake = createFakeVoice(opts());
    const v = await video("en");
    expect((await runTts(v.id, deps(fake))).kind).toBe("budget_refused");
    expect([fake.totalCalls(), await spent(v.id)]).toEqual([2, 2000]);
    expect(Number((await db.pool.query("select count(*) n from voice_lines")).rows[0].n)).toBe(2); // the paid lines were kept
    await setCap("video:scene_kit", 100_000); // a copy follows its template down, never up: raise both
    await setCap(`video:${v.id}`, 100_000);
    expect((await runTts(v.id, deps(fake))).kind).toBe("committed");
    expect([fake.totalCalls(), await spent(v.id)]).toEqual([4, 4000]);
  });
  it("a_cap_of_zero_is_not_no_limit", async () => {
    await setCap("video:scene_kit", 0);
    const fake = createFakeVoice(opts());
    const v = await video("en");
    expect((await runTts(v.id, deps(fake))).kind).toBe("budget_refused");
    expect(fake.totalCalls()).toBe(0);
  });
});

// --- a kill at every paid step ------------------------------------------------------------------------------------------

describe.each(POINTS)("kill at point %s", (point) => {
  const describePoint = { a: "before the reserve", b: "during the provider call", c: "after the provider returned, before settle", d: "after settle, before the line or clip is stored" }[point];
  const parks = point === "b" || point === "c";

  it.each([0, 1, 2, 3])(`tts_line_%i_${point}: killed ${describePoint}, the new fence pays nothing twice`, async (k) => {
    const script = point === "b" ? [...Array.from({ length: k }, () => ok(1000)), throwsUnknown("socket hang up"), ok(1000)] : undefined;
    const fake = createFakeVoice(opts({ ...(script && { script }) }));
    const v = await video("en");
    const stageId = await newStage(v.id, "tts");
    const handler = withAttempt({ db: db.pool, root }, ttsAttempt(deps(fake)));
    await expect(handler(await claimCtx(stageId, "tts", "h", "w1", portsFor(point, k)))).rejects.toThrow();
    const atKill = fake.totalCalls();
    expect(atKill).toBe(point === "a" ? k : k + 1);
    const again = await takeOver(stageId, "tts", "h");
    if (parks) {
      await expect(handler(again)).rejects.toBeInstanceOf(NeedsDecisionError); // unknown outcome: the owner decides, nothing is called
      expect(fake.totalCalls()).toBe(atKill);
      expect(await intentRows("done")).toBe(k);
    } else {
      await handler(again);
      expect(fake.totalCalls()).toBe(4); // a paid line replayed from its stored result is not paid for again
      expect(await spent(v.id)).toBe(4000);
      expect(await intentRows()).toBe(4);
      expect(Number((await db.pool.query("select count(*) n from voice_lines")).rows[0].n)).toBe(4);
    }
  }, 60_000);

  it(`sound_${point}: killed ${describePoint}, the generated clip is never paid for twice`, async () => {
    const v = await video("en");
    const hits = { n: 0 };
    const stageId = await newStage(v.id, "sfx", "plan");
    const first = await soundDeps(v.id, hits, point === "b");
    await expect(ensureSound(await claimCtx(stageId, "sfx", "plan", "w1", portsFor(point, 0)), first, need)).rejects.toThrow();
    const atKill = hits.n;
    expect(atKill).toBe(point === "a" ? 0 : 1);
    const again = await takeOver(stageId, "sfx", "plan");
    const second = await soundDeps(v.id, hits);
    if (parks) {
      await expect(ensureSound(again, second, need)).rejects.toBeInstanceOf(NeedsDecisionError);
      expect(hits.n).toBe(atKill);
    } else {
      const item = await ensureSound(again, second, need);
      expect(item.source).toBe("generated");
      expect(hits.n).toBe(1);
      expect(Number((await db.pool.query("select count(*) n from audio_items")).rows[0].n)).toBe(1);
    }
  }, 60_000);

  it(`image_${point}: killed ${describePoint}, the picture is never paid for twice`, async () => {
    const fake = createFakeImage({ pool: db.pool, ...(point === "b" && { script: [throwsUnknown("socket hang up"), ok(4000)] }) });
    const v = await video("en");
    const stageId = await newStage(v.id, "generate");
    const scope = await ensureCapScope(db.pool, `t21:image:${v.id}`, 1_000_000);
    const args = { prompt: "scene b1", aspect: "9:16" as const, model: "fake", budgetScopes: [scope] };
    await expect(fake.generate(await claimCtx(stageId, "generate", "h", "w1", portsFor(point, 0)), args)).rejects.toThrow();
    const atKill = fake.totalCalls();
    expect(atKill).toBe(point === "a" ? 0 : 1);
    const again = await takeOver(stageId, "generate", "h");
    if (parks) {
      await expect(fake.generate(again, args)).rejects.toBeInstanceOf(NeedsDecisionError);
      expect(fake.totalCalls()).toBe(atKill);
    } else {
      const r = await fake.generate(again, args);
      expect(r.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(fake.totalCalls()).toBe(1);
    }
  }, 60_000);
});

describe("kill inside the mix", () => {
  it("a_mix_killed_in_ffmpeg_resumes_on_the_new_fence_with_no_new_paid_call_and_a_clean_peak", async () => {
    const p = await produce("en", "native");
    const paidBefore = [p.fake.totalCalls(), p.hits.n, await intentRows()];
    const stageId = await newStage(p.v.id, "sfx");
    const dying = deps(p.fake, { mix: { ...mix(), runChild: async (s) => { if (s.args.some((a) => a.includes("sidechaincompress"))) throw new Died("mix killed"); return runChild(s); } } });
    await expect(sfxHandler({ db: db.pool, root }, dying)(await claimCtx(stageId, "sfx", "h", "w1"))).rejects.toBeInstanceOf(Died);
    const again = await takeOver(stageId, "sfx", "h");
    await sfxHandler({ db: db.pool, root }, p.d)(again);
    expect(peak(path.join(p.dir, "final.mp4"))).toBeLessThanOrEqual(-1.4);
    expect([p.fake.totalCalls(), p.hits.n, await intentRows()]).toEqual(paidBefore);
  }, 120_000);
});

// --- images and the async fal flow ---------------------------------------------------------------------------------------

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
const OPENAI_PRICE = { unit: "per_image", microUsd: 33_600 } as const;
const FAL_PRICE = { unit: "per_image", microUsd: 3000 } as const;
const imageArgs = (scope: string, model: string) => ({ prompt: "a red fox", aspect: "9:16" as const, model, budgetScopes: [scope] });

describe("generated images", () => {
  it("replaying_a_done_image_after_the_attempt_folder_is_gone_makes_no_provider_call_and_the_bytes_are_there", async () => {
    const v = await video("en");
    let hits = 0;
    const fetch: SafeFetch = async () => { hits++; return new Response(JSON.stringify({ data: [{ b64_json: PNG.toString("base64") }] }), { status: 200, headers: { "content-type": "application/json" } }); };
    const openai = createOpenAIImage({ fetch, getKey: async () => "k", price: OPENAI_PRICE, root });
    const scope = await ensureCapScope(db.pool, `t21:img:${v.id}`, 1_000_000);
    const stageId = await newStage(v.id, "generate");
    const first = await claimCtx(stageId, "generate", "h", "w1");
    const art = await openai.generate(first, imageArgs(scope, "gpt-image-1-mini"));
    expect(hits).toBe(1);
    const again = await takeOver(stageId, "generate", "h"); // new fence; the first attempt folder is swept
    expect(existsSync(first.attemptDir)).toBe(false);
    const replay = await openai.generate(again, imageArgs(scope, "gpt-image-1-mini"));
    expect(hits).toBe(1); // zero provider calls
    expect(replay.path).toBe(art.path);
    expect(readFileSync(replay.path).equals(PNG)).toBe(true); // the bytes live in the stable store, not the attempt folder
    expect(replay.path.startsWith(path.join(root, "generated-media"))).toBe(true);
  });

  // fal is submit, poll, download. Its job id is stored before any polling (media_jobs).
  async function falRun(kill: "submitting" | "submitted") {
    const v = await video("en");
    const reqs: string[] = [];
    const fetch: SafeFetch = async (url, init) => {
      const u = new URL(url);
      reqs.push(`${init.method ?? "GET"} ${u.pathname}`);
      if (init.method === "POST") {
        if (kill === "submitting") throw new TypeError("socket hang up"); // the request may have gone out; no job id came back
        return new Response(JSON.stringify({ request_id: "0a1b2c3d-1111-2222-3333-444455556666" }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response("{}", { status: 503 }); // polling keeps failing: the worker dies while the job is parked at the provider
    };
    const fal = createFalImage({ fetch, fetchCdn: fetch, db: db.pool, getKey: async () => "k", price: FAL_PRICE, root, sleep: async () => undefined });
    const scope = await ensureCapScope(db.pool, `t21:fal:${v.id}`, 1_000_000);
    const stageId = await newStage(v.id, "generate");
    await expect(fal.generate(await claimCtx(stageId, "generate", "h", "w1"), imageArgs(scope, "fal-ai/flux/schnell"))).rejects.toThrow();
    const jobs = async () => (await db.pool.query("select state, provider_job_id from media_jobs")).rows;
    return { fal, scope, stageId, reqs, jobs };
  }

  it("fal_submitted_job_parks_after_a_kill_and_a_resume_neither_submits_nor_polls", async () => {
    const t = await falRun("submitted");
    expect(await t.jobs()).toEqual([{ state: "submitted", provider_job_id: "0a1b2c3d-1111-2222-3333-444455556666" }]);
    expect(t.reqs.filter((r) => r.startsWith("POST"))).toHaveLength(1);
    const before = t.reqs.length;
    const again = await takeOver(t.stageId, "generate", "h");
    await expect(t.fal.generate(again, imageArgs(t.scope, "fal-ai/flux/schnell"))).rejects.toBeInstanceOf(NeedsDecisionError);
    expect(t.reqs).toHaveLength(before); // no second submit, no second charge, and no poll either
    expect(await intentRows("pending") + (await intentRows("unknown"))).toBe(1);
    expect(await t.jobs()).toEqual([{ state: "submitted", provider_job_id: "0a1b2c3d-1111-2222-3333-444455556666" }]);
  });

  it("fal_submit_killed_before_its_job_id_was_stored_parks_and_never_resubmits", async () => {
    const t = await falRun("submitting");
    expect((await t.jobs())[0]).toMatchObject({ state: "unknown" });
    const before = t.reqs.length;
    expect(before).toBe(1);
    const again = await takeOver(t.stageId, "generate", "h");
    await expect(t.fal.generate(again, imageArgs(t.scope, "fal-ai/flux/schnell"))).rejects.toBeInstanceOf(NeedsDecisionError);
    expect(t.reqs).toHaveLength(before);
  });
});
