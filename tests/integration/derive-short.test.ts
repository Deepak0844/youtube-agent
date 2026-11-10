import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sha256Hex } from "@/server/core/content-hash";
import { buildEngineConfig } from "@/server/core/engine-config";
import { uuidv7 } from "@/server/core/ids";
import type { StageOutcome } from "@/server/core/stage-runner";
import { approvalReaders } from "@/server/db/approval-readers";
import { approveGate, liveGateHash } from "@/server/db/approvals";
import { createDerivedShort } from "@/server/db/derive";
import { readNextAction } from "@/server/db/pipeline";
import { approvedScript } from "@/server/db/stage-content";
import { runStage } from "@/server/db/stage-runner-adapter";
import { addContent, createVideoRow, latestContent } from "@/server/db/videos";
import { runChild } from "@/server/render/child";
import { withAttempt } from "@/worker/stages/attempt";
import { deriveAttempt } from "@/worker/stages/derive";
import type { StageDeps } from "@/worker/stages/deps";
import { withTestDb, type TestDb } from "../support/db";

// A short cut from a long video, end to end on a real database and a real ffmpeg: the long video has 6 scenes of 10 s (one beat each, ten words per beat),
// narrated by a 60 s tone. Build's stored scene timing is deliberately wrong (every scene 5 s) to prove the clip uses the real narration times.
let db: TestDb;
let root: string;
const SESSION = { kind: "session", sessionId: "11111111-1111-4111-8111-111111111111" } as const;
const queued: string[] = [];
const queue = { enqueue: async (id: string) => (queued.push(id), `job.${id}`) };

beforeAll(async () => {
  db = await withTestDb();
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "derive-")));
});
afterAll(async () => {
  rmSync(root, { recursive: true, force: true });
  await db?.stop();
});
beforeEach(async () => {
  await db.reset();
  queued.length = 0;
  await db.pool.query("insert into sessions (id, token_hash, expires_at, absolute_expires_at) values ($1, 'derive', clock_timestamp() + interval '1 day', clock_timestamp() + interval '7 days') on conflict (id) do nothing", [SESSION.sessionId]);
});

const BEATS = ["c1_b1", "c1_b2", "c2_b1", "c2_b2", "c3_b1", "c3_b2"];
const beatWords = (i: number) => Array.from({ length: 10 }, (_, k) => `b${i}w${k}`);

/** A narrated long video with an approved script. `scenes` = how many of the 6 scenes exist. */
async function longVideo(o: { scenes?: number; narrate?: boolean } = {}): Promise<string> {
  const v = await createVideoRow(db.pool, { format: "long", kind: "scene_kit", language: "en", topic: "Why the sea is salty", lengthMinMinutes: 3, lengthMaxMinutes: 8, style: "ai_studio", captionStyle: null });
  const run = uuidv7();
  await addContent(db.pool, v.id, "script", { body: { title: "T", narration: BEATS.flatMap((_, i) => beatWords(i)).join(" ") }, sha256: sha256Hex("script"), producedBy: run });
  await addContent(db.pool, v.id, "beats", { body: { beats: BEATS.map((id, i) => ({ id, text: beatWords(i).join(" "), est_start: i * 5, est_end: i * 5 + 5 })) }, sha256: sha256Hex("beats"), producedBy: run });
  await addContent(db.pool, v.id, "evidence", { body: { claims: [{ text: "salt comes from rocks", kind: "computed", method: "m" }] }, sha256: sha256Hex("evidence"), producedBy: run });
  const n = o.scenes ?? 6;
  const doc = { version: 1, scenes: BEATS.slice(0, n).map((beat, i) => ({ id: `s${i + 1}`, kind: "terminal", beat, startMs: i * 5000, durationMs: 5000, lines: [{ text: `line ${i}` }] })) };
  await addContent(db.pool, v.id, "scenes", { body: doc, sha256: sha256Hex("scenes") });
  if (o.narrate !== false) {
    mkdirSync(path.join(root, "videos", v.id), { recursive: true });
    execFileSync("ffmpeg", ["-nostdin", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=60", "-ar", "22050", "-ac", "1", "-c:a", "pcm_s16le", path.join(root, "videos", v.id, "narration.wav")]);
    const words = BEATS.flatMap((_, i) => beatWords(i).map((word, k) => ({ word, startS: i * 10 + k, endS: i * 10 + k + 0.9, source: "recognised", flags: [] })));
    await addContent(db.pool, v.id, "narration", { body: { file: "narration.wav", word_timings: "aligned", lang: "en", provider: "fake" }, sha256: sha256Hex("narration") });
    await addContent(db.pool, v.id, "captions", { body: { words, needs_check: false }, sha256: sha256Hex("captions") });
  }
  const seen = (await liveGateHash(db.pool, v.id, "script"))!.hash;
  expect(await approveGate(db.pool, { videoId: v.id, gate: "script", seenHash: seen, actor: SESSION })).toMatchObject({ ok: true });
  return v.id;
}

const deps = () => ({ db: db.pool, root, mix: { runChild: (s: Parameters<typeof runChild>[0]) => runChild(s), audioRoot: path.join(root, "audio") } }) as unknown as StageDeps;
const noProvider = { call: async () => Promise.reject(new Error("no provider")) };
async function runDerive(videoId: string): Promise<StageOutcome> {
  const row = (await db.pool.query<{ id: string; input_hash: string }>("select id, input_hash from stage_runs where video_id = $1 and name = 'derive' and status = 'queued' order by created_at desc limit 1", [videoId])).rows[0]!;
  return runStage(db.pool, { provider: noProvider, ttlMs: 60_000, workerId: "w1", handler: withAttempt({ db: db.pool, root } as never, deriveAttempt(deps())), config: buildEngineConfig(new Map()) }, { stageRunId: row.id, inputHash: row.input_hash });
}
/** The reason the newest derive run of a video failed with. */
const failure = async (videoId: string): Promise<string> => (await db.pool.query<{ result: { error?: string } | null }>("select result from stage_runs where video_id = $1 and name = 'derive' order by created_at desc limit 1", [videoId])).rows[0]?.result?.error ?? "";
const probeS = (f: string) => Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", f]).toString().trim());

describe("createDerivedShort", () => {
  it("creates a short from the long video's language, channel and look, with its range, and queues the free derive step (never Draft)", async () => {
    const src = await longVideo();
    const r = await createDerivedShort(db.pool, queue, { sourceId: src, fromScene: 1, toScene: 3, title: "The salty clip" }, SESSION.sessionId);
    if (!r.ok) throw new Error(r.message);
    const row = (await db.pool.query("select format, kind, language, topic, style, derived_from, derive_from_scene, derive_to_scene from videos where id = $1", [r.videoId])).rows[0];
    expect(row).toEqual({ format: "short", kind: "scene_kit", language: "en", topic: "The salty clip", style: "ai_studio", derived_from: src, derive_from_scene: 1, derive_to_scene: 3 });
    expect((await db.pool.query("select name from stage_runs where video_id = $1 order by created_at", [r.videoId])).rows.map((x) => x.name)).toEqual(["derive"]);
    expect(queued).toHaveLength(1);
    expect((await db.pool.query("select detail from audit_log where event = 'video.derived_created'")).rows[0].detail).toMatchObject({ videoId: r.videoId, sourceId: src, fromScene: 1, toScene: 3 });
  });
  it("refuses a short as the source, a missing or cancelled video, a bad range, a long video with no scenes, and the same scenes twice", async () => {
    const src = await longVideo();
    const short = await createVideoRow(db.pool, { format: "short", kind: "scene_kit", language: "en", topic: "t" });
    expect(await createDerivedShort(db.pool, queue, { sourceId: short.id, fromScene: 0, toScene: 1 })).toMatchObject({ ok: false, message: expect.stringMatching(/only be made from a long video/) });
    for (const sourceId of ["00000000-0000-4000-8000-000000000000", "not-a-uuid"]) expect(await createDerivedShort(db.pool, queue, { sourceId, fromScene: 0, toScene: 1 }), sourceId).toMatchObject({ ok: false, message: expect.stringMatching(/not found/) });
    for (const [a, b] of [[-1, 2], [3, 2], [1.5, 2], [0, Number.NaN]] as const) expect(await createDerivedShort(db.pool, queue, { sourceId: src, fromScene: a, toScene: b }), `${a}-${b}`).toMatchObject({ ok: false, message: expect.stringMatching(/first and a last scene/) });
    expect(await createDerivedShort(db.pool, queue, { sourceId: src, fromScene: 0, toScene: 6 })).toMatchObject({ ok: false, message: expect.stringMatching(/has 6 scenes/) });
    const bare = await createVideoRow(db.pool, { format: "long", kind: "scene_kit", language: "en", topic: "t", lengthMinMinutes: 3, lengthMaxMinutes: 8 });
    expect(await createDerivedShort(db.pool, queue, { sourceId: bare.id, fromScene: 0, toScene: 1 })).toMatchObject({ ok: false, message: expect.stringMatching(/no scenes yet/) });
    await db.pool.query("update videos set status = 'cancelled' where id = $1", [bare.id]);
    expect(await createDerivedShort(db.pool, queue, { sourceId: bare.id, fromScene: 0, toScene: 1 })).toMatchObject({ ok: false, message: expect.stringMatching(/cancelled/) });
    expect((await createDerivedShort(db.pool, queue, { sourceId: src, fromScene: 0, toScene: 2 })).ok).toBe(true);
    expect(await createDerivedShort(db.pool, queue, { sourceId: src, fromScene: 0, toScene: 2 })).toMatchObject({ ok: false, message: expect.stringMatching(/already exists/) });
  });
  it("the database refuses a derived long video, a half range and a source without a range", async () => {
    const src = await longVideo();
    await expect(db.pool.query("insert into videos (format, kind, language, topic, length_min_minutes, length_max_minutes, derive_from_scene, derive_to_scene) values ('long','scene_kit','en','t',3,8,0,1)")).rejects.toThrow(/videos_derive_range_check/);
    await expect(db.pool.query("insert into videos (format, kind, language, topic, derive_from_scene) values ('short','scene_kit','en','t',0)")).rejects.toThrow(/videos_derive_both_check/);
    await expect(db.pool.query("insert into videos (format, kind, language, topic, derived_from) values ('short','scene_kit','en','t',$1)", [src])).rejects.toThrow(/videos_derive_source_check/);
  });
});

describe("derive stage", () => {
  it("cuts the clip at the REAL narration times: scenes shifted to 0, the narration and captions of those 30 s, one script/beats/evidence set", async () => {
    const src = await longVideo();
    const r = await createDerivedShort(db.pool, queue, { sourceId: src, fromScene: 1, toScene: 3 });
    if (!r.ok) throw new Error(r.message);
    const out = await runDerive(r.videoId);
    expect(out.kind).toBe("committed");

    const scenes = JSON.parse(readFileSync(path.join(root, "videos", r.videoId, "scenes.json"), "utf8"));
    expect(scenes.scenes.map((s: { id: string; beat: string; startMs: number; durationMs: number }) => [s.id, s.beat, s.startMs, s.durationMs])).toEqual([["s2", "c1_b2", 0, 10_000], ["s3", "c2_b1", 10_000, 10_000], ["s4", "c2_b2", 20_000, 10_000]]);
    expect(probeS(path.join(root, "videos", r.videoId, "narration.wav"))).toBeCloseTo(30, 1);

    const caps = (await latestContent(db.pool, r.videoId, "captions"))!.body as { words: Array<{ word: string; startS: number; endS: number }>; needs_check: boolean };
    expect(caps.words).toHaveLength(30);
    expect(caps.words[0]).toMatchObject({ word: "b1w0", startS: 0, endS: 0.9 });
    expect(caps.words[29]).toMatchObject({ word: "b3w9", startS: 29 });
    expect(caps.needs_check).toBe(false);
    const nar = (await latestContent(db.pool, r.videoId, "narration"))!.body as { file: string; derived_from: string; audio_sha256: string };
    expect(nar).toMatchObject({ file: "narration.wav", derived_from: src });
    expect(nar.audio_sha256).toMatch(/^[0-9a-f]{64}$/);

    // The script, its beats and its evidence were saved by ONE run, so the approved script finds its beats.
    const seen = (await liveGateHash(db.pool, r.videoId, "script"))!.hash;
    expect(await approveGate(db.pool, { videoId: r.videoId, gate: "script", seenHash: seen, actor: SESSION })).toMatchObject({ ok: true });
    const ap = await approvedScript(db.pool, r.videoId);
    expect(ap.ok && ap.script).toEqual({ title: "Why the sea is salty", narration: [1, 2, 3].flatMap((i) => beatWords(i)).join(" ") }); // no title given: the long video's topic
    expect(ap.ok && ap.beats.map((b) => b.id)).toEqual(["c1_b2", "c2_b1", "c2_b2"]);
    expect(ap.ok && ap.beats.every((b) => !("est_start" in b))).toBe(true); // the long video's time estimates are not carried over
    expect((await latestContent(db.pool, r.videoId, "evidence"))!.body).toEqual({ claims: [{ text: "salt comes from rocks", kind: "computed", method: "m" }] });

    // After the script approval the route goes on to Render (no Draft, Build or Narration).
    expect(await readNextAction(db.pool, r.videoId, approvalReaders)).toMatchObject({ kind: "enqueue", stage: "render" });
  });
  it("waits for the owner's script approval before anything else, and never drafts", async () => {
    const src = await longVideo();
    const r = await createDerivedShort(db.pool, queue, { sourceId: src, fromScene: 1, toScene: 3 });
    if (!r.ok) throw new Error(r.message);
    await runDerive(r.videoId);
    expect(await readNextAction(db.pool, r.videoId, approvalReaders)).toEqual({ kind: "wait_gate", gate: "script" });
    expect((await db.pool.query("select count(*)::int n from stage_runs where video_id = $1 and name in ('draft', 'build', 'tts')", [r.videoId])).rows[0].n).toBe(0);
  });
  it("fails plainly, with nothing saved, for a clip that is too short, a long video not narrated yet, and a long video that is gone", async () => {
    const src = await longVideo();
    const tooShort = await createDerivedShort(db.pool, queue, { sourceId: src, fromScene: 0, toScene: 0 });
    if (!tooShort.ok) throw new Error(tooShort.message);
    expect((await runDerive(tooShort.videoId)).kind).toBe("known_failure");
    expect(await failure(tooShort.videoId)).toMatch(/at least 15 seconds; this is 10/);
    expect(await latestContent(db.pool, tooShort.videoId, "script")).toBeNull();

    const silent = await longVideo({ narrate: false });
    const r2 = await createDerivedShort(db.pool, queue, { sourceId: silent, fromScene: 0, toScene: 2 });
    if (!r2.ok) throw new Error(r2.message);
    expect((await runDerive(r2.videoId)).kind).toBe("known_failure");
    expect(await failure(r2.videoId)).toMatch(/no narration or caption times yet/);
    expect(await latestContent(db.pool, r2.videoId, "scenes")).toBeNull();

    const r3 = await createDerivedShort(db.pool, queue, { sourceId: src, fromScene: 1, toScene: 3 });
    if (!r3.ok) throw new Error(r3.message);
    await db.pool.query("update videos set derived_from = null where id = $1", [r3.videoId]); // what deleting the long video does
    expect((await runDerive(r3.videoId)).kind).toBe("known_failure");
    expect(await failure(r3.videoId)).toMatch(/no longer exists/);
    expect(existsSync(path.join(root, "videos", r3.videoId, "scenes.json"))).toBe(false);
    // Still known to be derived: the route never falls back to the paid Draft step.
    expect(await readNextAction(db.pool, r3.videoId, approvalReaders)).not.toMatchObject({ stage: "draft" });
  });
  it("goes stale and runs again when the long video's content changes", async () => {
    const src = await longVideo();
    const r = await createDerivedShort(db.pool, queue, { sourceId: src, fromScene: 1, toScene: 3 });
    if (!r.ok) throw new Error(r.message);
    await runDerive(r.videoId);
    expect(await readNextAction(db.pool, r.videoId, approvalReaders)).toEqual({ kind: "wait_gate", gate: "script" });
    await addContent(db.pool, src, "captions", { body: { words: [], changed: true }, sha256: sha256Hex("captions-2") });
    expect(await readNextAction(db.pool, r.videoId, approvalReaders)).toMatchObject({ kind: "enqueue", stage: "derive" });
  });
});
