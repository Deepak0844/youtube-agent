// First real path on compressed audio: an mp3-only voice (fake provider) -> tts -> mux onto a render -> sfx mix, with real ffmpeg.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { canonicalJson, sha256Hex } from "@/server/core/content-hash";
import { buildEngineConfig } from "@/server/core/engine-config";
import { uuidv7 } from "@/server/core/ids";
import type { StageContext } from "@/server/core/stage-handler";
import { approveGate, liveGateHash } from "@/server/db/approvals";
import { addAudioItem } from "@/server/db/audio-library";
import { runStage } from "@/server/db/stage-runner-adapter";
import { insertQueuedStage } from "@/server/db/stages";
import { addContent, createVideoRow } from "@/server/db/videos";
import { createFakeVoice } from "@/server/providers/voice/fake";
import type { VoiceProvider } from "@/server/providers/voice";
import { runChild, type ChildSpec } from "@/server/render/child";
import { withAttempt } from "@/worker/stages/attempt";
import type { StageDeps } from "@/worker/stages/deps";
import { sfxHandler } from "@/worker/stages/sfx";
import { ttsAttempt } from "@/worker/stages/tts";
import { voiceAttempt } from "@/worker/stages/voice";
import { withTestDb, type TestDb } from "../support/db";
import { assertFfprobeAvailable } from "../support/tools";

let db: TestDb;
let root: string;
let audioRoot: string;
const config = buildEngineConfig(new Map());
const SESSION = { kind: "session", sessionId: "11111111-1111-4111-8111-111111111111" } as const;
const noProvider = { call: async () => Promise.reject(new Error("no provider")) };
const ff = (...a: string[]) => execFileSync("ffmpeg", ["-nostdin", "-v", "error", "-y", ...a]);
const probe = (file: string, entry: string) => execFileSync("ffprobe", ["-v", "error", "-show_entries", entry, "-of", "csv=p=0", file], { encoding: "utf8" }).trim();
const peak = (file: string) => Number(/max_volume:\s*(-?[\d.]+)/.exec(spawnSync("ffmpeg", ["-nostdin", "-hide_banner", "-i", file, "-af", "volumedetect", "-f", "null", "-"], { encoding: "utf8" }).stderr)![1]);

beforeAll(async () => {
  assertFfprobeAvailable();
  db = await withTestDb();
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "mp3-e2e-")));
  audioRoot = path.join(root, "audio");
  mkdirSync(audioRoot);
  ff("-f", "lavfi", "-i", "sine=f=1000:d=1", "-af", "volume=15dB", path.join(audioRoot, "loud.wav"));
}, 120_000);
afterAll(async () => {
  rmSync(root, { recursive: true, force: true });
  await db?.stop();
});
beforeEach(async () => {
  await db.reset();
  await db.pool.query("insert into budgets (scope, cap_micro_usd) values ('draft_run', 3000000), ('video:scene_kit', 2000000), ('day', 15000000), ('month', 100000000)");
});

/** The fake voice, but its audio is a real quiet tone saved as mp3 (the only format it claims). */
function mp3Voice(scopes: string[]): VoiceProvider {
  const inner = createFakeVoice({ pool: db.pool }).forScopes(scopes);
  return {
    ...inner,
    capability: { ...inner.capability, formats: ["mp3"] },
    async synthesise(ctx: StageContext, a) {
      const r = await inner.synthesise(ctx, a);
      const out = r.audioPath.replace(/\.wav$/, ".mp3");
      ff("-f", "lavfi", "-i", "sine=f=220:d=1.5", "-af", "volume=-17dB", "-c:a", "libmp3lame", "-b:a", "64k", out);
      await rm(r.audioPath, { force: true });
      return { ...r, audioPath: out };
    },
  };
}

async function run(id: string, name: string, handler: ReturnType<typeof withAttempt>) {
  const inputHash = `h-${uuidv7()}`;
  const stageRunId = await insertQueuedStage(db.pool, { videoId: id, name, inputHash });
  return runStage(db.pool, { provider: noProvider, ttlMs: 60_000, workerId: "w1", handler, config }, { stageRunId, inputHash });
}

describe("mp3 voice, mux and mix (real ffmpeg)", () => {
  it.each(["plan", "cue sheet"])("an mp3 voice becomes narration, is muxed onto the render and mixed with a cue from a %s into final.mp4", async (source) => {
    const v = await createVideoRow(db.pool, { format: "short", kind: "scene_kit", language: "en", topic: "t" });
    const script = { title: "T", narration: "One fine line. Two fine lines." };
    await addContent(db.pool, v.id, "script", { body: script, sha256: sha256Hex(canonicalJson(script)) });
    const beats = { beats: [{ id: "b1", text: "x" }] };
    await addContent(db.pool, v.id, "beats", { body: beats, sha256: sha256Hex(canonicalJson(beats)) });
    const live = await liveGateHash(db.pool, v.id, "script");
    expect((await approveGate(db.pool, { videoId: v.id, gate: "script", seenHash: live!.hash, actor: SESSION })).ok).toBe(true);

    const d = {
      db: db.pool, root, mix: { runChild: (s: ChildSpec) => runChild(s), audioRoot },
      voiceFor: async (a: { budgetScopes: string[] }) => ({ provider: mp3Voice(a.budgetScopes), providerId: "fake", voice: "fake" }),
      image: {} as never, renderer: {} as never,
    } as unknown as StageDeps;
    const fin = { db: db.pool, root };

    expect((await run(v.id, "tts", withAttempt(fin, ttsAttempt(d)))).kind).toBe("committed");
    const lines = await db.pool.query<{ file_path: string }>("select file_path from voice_lines");
    expect(lines.rows.length).toBe(2);
    expect(lines.rows.every((r) => r.file_path.endsWith(".mp3"))).toBe(true);

    const dir = path.join(root, "videos", v.id);
    const narrationS = Number(probe(path.join(dir, "narration.wav"), "format=duration"));
    ff("-f", "lavfi", "-i", `color=c=black:s=64x64:r=10:d=${narrationS.toFixed(3)}`, "-an", "-pix_fmt", "yuv420p", path.join(dir, "render.mp4"));
    expect((await run(v.id, "voice", withAttempt(fin, voiceAttempt(d)))).kind).toBe("committed");
    expect(existsSync(path.join(dir, "voiced.mp4"))).toBe(true);

    const item = await addAudioItem(db.pool, { kind: "sfx", name: "loud", tags: ["whoosh"], source: "owned", licence: "own", provenance: {}, filePath: "loud.wav", sha256: "b".repeat(64), durationS: 1, meanLufs: -6, peakDbfs: -1 });
    if (source === "plan") writeFileSync(path.join(dir, "sfx-plan.json"), JSON.stringify({ version: 1, cues: [{ id: "a", itemId: item.id, atS: 0.5, gainDb: 0, optional: false }] }));
    else {
      mkdirSync(path.join(audioRoot, "sfx"), { recursive: true });
      writeFileSync(path.join(audioRoot, "sfx", "palette.json"), JSON.stringify({ defaults: { model: "m", target_lufs: -20, ceiling_dbfs: -1.5 }, sounds: [{ id: "whoosh", category: "c", duration_s: 1, tags: ["whoosh"], prompt: "p" }] }));
      writeFileSync(path.join(dir, "sfx-cues.json"), JSON.stringify({ cues: [{ id: "a", sound: "whoosh", atS: 0.5, gainDb: 0, optional: false }] }));
    }
    const out = (await run(v.id, "sfx", sfxHandler(fin, d))) as { kind: string };
    expect(out.kind).toBe("committed");

    const final = path.join(dir, "final.mp4");
    expect(probe(final, "stream=codec_type")).toContain("audio");
    expect(Math.abs(Number(probe(final, "format=duration")) - narrationS)).toBeLessThan(0.5);
    expect(peak(final)).toBeLessThan(0);
    expect(((await db.pool.query("select used_in from audio_items where id = $1", [item.id])).rows[0].used_in as string[])).toContain(v.id); // the cue was really mixed
  }, 120_000);
});
