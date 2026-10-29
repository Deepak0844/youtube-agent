import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildEngineConfig } from "@/server/core/engine-config";
import { LeaseLostError } from "@/server/core/paid-call";
import { createStageContext, type StageContext } from "@/server/core/stage-handler";
import { addAudioItem } from "@/server/db/audio-library";
import { createPgPaidCallPorts } from "@/server/db/paid-call-adapter";
import { claimStage, insertQueuedStage } from "@/server/db/stages";
import { addContent, createVideoRow } from "@/server/db/videos";
import { runChild, type ChildSpec } from "@/server/render/child";
import { withAttempt } from "@/worker/stages/attempt";
import type { StageDeps } from "@/worker/stages/deps";
import { sfxHandler } from "@/worker/stages/sfx";
import { voiceAttempt } from "@/worker/stages/voice";
import { withTestDb, type TestDb } from "../support/db";
import { assertFfprobeAvailable } from "../support/tools";

let db: TestDb;
let root: string;
let audioRoot: string;
const config = buildEngineConfig(new Map());
const ff = (...a: string[]) => execFileSync("ffmpeg", ["-nostdin", "-v", "error", "-y", ...a]);
const dur = (file: string) => Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file], { encoding: "utf8" }));
const peak = (file: string) => {
  const r = spawnSync("ffmpeg", ["-nostdin", "-hide_banner", "-i", file, "-af", "volumedetect", "-f", "null", "-"], { encoding: "utf8" });
  return Number(/max_volume:\s*(-?[\d.]+)/.exec(r.stderr)![1]);
};

beforeAll(async () => {
  assertFfprobeAvailable();
  db = await withTestDb();
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "mix-")));
  audioRoot = path.join(root, "audio");
  mkdirSync(audioRoot);
  ff("-f", "lavfi", "-i", "sine=f=220:d=6", "-af", "volume=-17dB", path.join(root, "voice.wav")); // mean about -20 dB
  ff("-f", "lavfi", "-i", "color=c=black:s=64x64:r=10:d=6", "-an", "-pix_fmt", "yuv420p", path.join(root, "render.mp4"));
  ff("-f", "lavfi", "-i", "sine=f=1000:d=1", "-af", "volume=15dB", path.join(audioRoot, "loud.wav")); // mean about -6 dB
});
afterAll(async () => {
  rmSync(root, { recursive: true, force: true });
  await db?.stop();
});
beforeEach(() => db.reset());

async function setup(plan: unknown) {
  const v = await createVideoRow(db.pool, { format: "short", kind: "scene_kit", language: "en", topic: "t" });
  const dir = path.join(root, "videos", v.id);
  mkdirSync(dir, { recursive: true });
  for (const f of ["voice.wav", "render.mp4"]) writeFileSync(path.join(dir, f), readFileSync(path.join(root, f)));
  await addContent(db.pool, v.id, "narration", { body: { file: "voice.wav" }, sha256: "a".repeat(64) });
  const item = await addAudioItem(db.pool, { kind: "sfx", name: "loud", tags: [], source: "owned", licence: "own", provenance: {}, filePath: "loud.wav", sha256: "b".repeat(64), durationS: 1, meanLufs: -6, peakDbfs: -1 });
  if (plan) writeFileSync(path.join(dir, "sfx-plan.json"), JSON.stringify(plan).replaceAll("ITEM", item.id));
  return { v, dir, item };
}

async function stageCtx(videoId: string, name: string, workerId = "w1") {
  const stageId = await insertQueuedStage(db.pool, { videoId, name, inputHash: "h" });
  const claim = (await claimStage(db.pool, { id: stageId, inputHash: "h", workerId, ttlMs: 600_000 }))!;
  const ctx: StageContext = createStageContext({ stage: { id: stageId, name, inputHash: "h", videoId }, claim, config, signal: new AbortController().signal, paid: createPgPaidCallPorts(db.pool) }).ctx;
  return { ctx, stageId };
}
const mkDeps = (over: Partial<NonNullable<StageDeps["mix"]>> = {}) => ({ db: db.pool, root, mix: { runChild: (s: ChildSpec) => runChild(s), audioRoot, ...over } }) as unknown as StageDeps;
const usedIn = async (id: string) => (await db.pool.query("select used_in from audio_items where id = $1", [id])).rows[0].used_in as string[];
const cue = (id: string, atS: number, gainDb: number, optional = false) => ({ id, itemId: "ITEM", atS, gainDb, optional });

async function voiceThenSfx(plan: unknown, deps = mkDeps()) {
  const s = await setup(plan);
  const fin = { db: db.pool, root };
  await withAttempt(fin, voiceAttempt(deps))((await stageCtx(s.v.id, "voice")).ctx);
  return { ...s, fin, deps, run: async () => sfxHandler(fin, deps)((await stageCtx(s.v.id, "sfx")).ctx) as Promise<{ droppedCues: string[] }> };
}

describe("mixer (real ffmpeg)", () => {
  it("loud overlapping cues mixed, peak stays under the ceiling, cue sheet written, used_in set after commit", async () => {
    const plan = { version: 1, cues: [cue("a", 1, 6), cue("b", 1.2, 6), cue("late", 9, 6, true)] };
    const s = await voiceThenSfx(plan);
    const r = await s.run();
    expect(r.droppedCues).toEqual(["late"]);
    expect(peak(path.join(s.dir, "final.mp4"))).toBeLessThanOrEqual(-1.4);
    expect(dur(path.join(s.dir, "final.mp4"))).toBeCloseTo(6, 0);
    expect(readFileSync(path.join(s.dir, "cue-sheet.txt"), "utf8")).toContain("optional");
    expect(await usedIn(s.item.id)).toEqual([s.v.id]);
  });

  it("zero cues passes through at the video length", async () => {
    const s = await voiceThenSfx(null);
    await s.run();
    expect(dur(path.join(s.dir, "final.mp4"))).toBeCloseTo(6, 0);
    expect(await usedIn(s.item.id)).toEqual([]);
  });

  it("required_inaudible_cue_fails_with_ids_optional_dropped", async () => {
    const bad = await voiceThenSfx({ version: 1, cues: [cue("hidden", 1, -30), cue("ok", 3, 6)] });
    await expect(bad.run()).rejects.toThrow(/hidden/);
    expect(existsSync(path.join(bad.dir, "final.mp4"))).toBe(false);
    const soft = await voiceThenSfx({ version: 1, cues: [cue("hidden", 1, -30, true), cue("ok", 3, 6)] });
    expect((await soft.run()).droppedCues).toEqual(["hidden"]);
  });

  it("used_in_not_updated_when_the_stage_is_discarded", async () => {
    const lost = { videoId: "", stageId: "", taken: false };
    const s = await voiceThenSfx({ version: 1, cues: [cue("a", 1, 6)] }, mkDeps({
      runChild: async (spec) => {
        const r = await runChild(spec);
        if (!lost.taken && spec.args.some((a) => a.includes("sidechaincompress"))) {
          lost.taken = true; // another worker takes the sfx stage over after the mix ran, before the attempt is promoted
          await db.ownerPool.query("update stage_runs set status='queued', lease_owner=null, lease_until=null where id=$1", [lost.stageId]);
          await claimStage(db.pool, { id: lost.stageId, inputHash: "h", workerId: "w2", ttlMs: 600_000 });
        }
        return r;
      },
    }));
    const { ctx, stageId } = await stageCtx(s.v.id, "sfx");
    lost.stageId = stageId;
    await expect(sfxHandler(s.fin, s.deps)(ctx)).rejects.toBeInstanceOf(LeaseLostError);
    expect(await usedIn(s.item.id)).toEqual([]);
    expect(existsSync(path.join(s.dir, "final.mp4"))).toBe(false);
  });
});
