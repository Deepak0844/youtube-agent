import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildEngineConfig } from "@/server/core/engine-config";
import { uuidv7 } from "@/server/core/ids";
import type { StageOutcome } from "@/server/core/stage-runner";
import { createClipSource, SOURCE_NOTE } from "@/server/db/clip-source";
import { requestClips } from "@/server/db/clips";
import { loadClipsTab } from "@/server/db/clips-tab";
import { runStage } from "@/server/db/stage-runner-adapter";
import { latestContent } from "@/server/db/videos";
import { createFakeImage } from "@/server/providers/media/fake";
import { createFakeRenderer } from "@/server/providers/renderer/fake";
import type { Transcriber } from "@/server/providers/stt/voicestudio-stt";
import { createFakeVoice } from "@/server/providers/voice/fake";
import { runChild, type ChildSpec } from "@/server/render/child";
import { withAttempt } from "@/worker/stages/attempt";
import type { StageDeps } from "@/worker/stages/deps";
import { ingestSourceAttempt } from "@/worker/stages/ingest-source";
import { withTestDb, type TestDb } from "../support/db";
import { assertFfprobeAvailable } from "../support/tools";

// Clip Factory CF5 (U2): an uploaded video becomes a clip source. Real ffmpeg and a real database; the speech-to-text is a fake here (the real one
// is checked by hand against VoiceStudio). The raw upload is always deleted, and only a plain video container is accepted.

let db: TestDb;
let root: string;
beforeAll(async () => {
  assertFfprobeAvailable();
  db = await withTestDb();
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "clip-source-")));
  mkdirSync(path.join(root, "tmp"), { recursive: true });
});
afterAll(async () => {
  rmSync(root, { recursive: true, force: true });
  await db?.stop();
});
beforeEach(async () => {
  await db.reset();
});

const noProvider = { call: async () => Promise.reject(new Error("no provider in handler mode")) };
const queue = { enqueue: async () => "job" };

function deps(): StageDeps {
  const voice = createFakeVoice();
  return { db: db.pool, root, voiceFor: async (a: { budgetScopes: string[] }) => ({ provider: voice.forScopes(a.budgetScopes), providerId: "fake", voice: "fake" }), image: createFakeImage(), renderer: createFakeRenderer({ fixture: path.resolve("tests/fixtures/video/short.mp4") }), mix: { runChild: (s: ChildSpec) => runChild(s), audioRoot: root } } as unknown as StageDeps;
}
/** One word every 0.4 s over the whole chunk it is given (the chunk length is read from the wav's size: 16 kHz mono 16-bit). */
const talker = (seen: number[] = []): Transcriber => ({
  async transcribe(wav) {
    const secs = (wav.length - 44) / 32000;
    seen.push(Math.round(secs));
    return Array.from({ length: Math.floor(secs / 0.4) - 1 }, (_, i) => ({ word: `word${i}`, startS: 0.2 + i * 0.4, endS: 0.2 + i * 0.4 + 0.3 }));
  },
});
async function upload(secs = 70): Promise<string> {
  const f = path.join(root, "tmp", `${uuidv7()}.part`);
  const r = spawnSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", `testsrc2=size=1280x720:rate=25:duration=${secs}`, "-f", "lavfi", "-i", `sine=frequency=300:duration=${secs}`, "-shortest", "-pix_fmt", "yuv420p", "-f", "mp4", f]);
  if (r.status !== 0) throw new Error(String(r.stderr));
  return f;
}
async function run(videoId: string, transcriber: Transcriber): Promise<StageOutcome> {
  const q = (await db.pool.query<{ id: string; input_hash: string }>("select id, input_hash from stage_runs where video_id = $1 and name = 'ingest_source'", [videoId])).rows[0]!;
  return runStage(db.pool, { provider: noProvider, ttlMs: 60_000, workerId: "w1", handler: withAttempt({ db: db.pool, root }, ingestSourceAttempt(deps(), { transcriber: async () => transcriber })), config: buildEngineConfig(new Map()) }, { stageRunId: q.id, inputHash: q.input_hash });
}
const errorOf = async (id: string) => (await db.pool.query<{ result: { error: string } }>("select result from stage_runs where video_id = $1 and name = 'ingest_source'", [id])).rows[0]!.result.error;
const mk = async (file: string, over: Partial<Parameters<typeof createClipSource>[2]> = {}) => {
  const r = await createClipSource(db.pool, queue, { root, tempFile: file, sizeBytes: 1000, fileName: "My talk.mp4", language: "en", ...over });
  if (!r.ok) throw new Error(r.message);
  return r.videoId;
};

describe("createClipSource", () => {
  it("stores the upload next to a new done video row and queues the ingest step; nothing is drafted or approved", async () => {
    const f = await upload();
    const id = await mk(f, { fileName: "Quarterly review.mov" });
    expect(existsSync(f)).toBe(false); // moved, not copied
    expect(existsSync(path.join(root, "videos", id, "upload.bin"))).toBe(true);
    const row = (await db.pool.query("select status, topic, notes, format, kind from videos where id = $1", [id])).rows[0];
    expect(row).toMatchObject({ status: "done", topic: "Quarterly review", notes: SOURCE_NOTE, format: "short", kind: "tsx" });
    expect((await db.pool.query("select name, status from stage_runs where video_id = $1", [id])).rows).toEqual([{ name: "ingest_source", status: "queued" }]);
    expect((await db.pool.query("select 1 from approvals where video_id = $1", [id])).rowCount).toBe(0);
  }, 120_000);

  it("refuses a bad language and an empty upload in plain words and leaves the file where it was", async () => {
    const f = await upload(22);
    expect(await createClipSource(db.pool, queue, { root, tempFile: f, sizeBytes: 100, fileName: "a.mp4", language: "xx" })).toMatchObject({ ok: false, message: expect.stringMatching(/language/) });
    expect(await createClipSource(db.pool, queue, { root, tempFile: f, sizeBytes: 0, fileName: "a.mp4", language: "en" })).toMatchObject({ ok: false, message: expect.stringMatching(/empty/) });
    expect(existsSync(f)).toBe(true);
  }, 60_000);
});

describe("ingest_source stage", () => {
  it("re-encodes the upload, listens to it in 60 s pieces and saves word times on the video's own timeline; the raw upload is deleted", async () => {
    const id = await mk(await upload(70));
    const seen: number[] = [];
    const out = await run(id, talker(seen));
    expect(out.kind).toBe("committed");
    expect(seen).toEqual([60, 10]); // a 70 s video: one 60 s piece and one 10 s piece
    const final = path.join(root, "videos", id, "final.mp4");
    const p = JSON.parse(spawnSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_name,width,height:format=duration", "-of", "json", final], { encoding: "utf8" }).stdout) as { streams: { codec_name: string; width?: number }[]; format: { duration: string } };
    expect(p.streams.map((s) => s.codec_name).sort()).toEqual(["aac", "h264"]);
    expect(Math.abs(Number(p.format.duration) - 70)).toBeLessThan(1);
    expect(existsSync(path.join(root, "videos", id, "upload.bin"))).toBe(false);
    const caps = (await latestContent(db.pool, id, "captions"))!.body as { words: { word: string; startS: number; endS: number }[]; timings_kind: string };
    expect(caps.timings_kind).toBe("aligned");
    expect(caps.words.length).toBeGreaterThan(100);
    const second = caps.words.find((w) => w.startS >= 60)!;
    expect(second.startS).toBeGreaterThanOrEqual(60.19); // the second piece's words sit after 60 s
    expect(Math.max(...caps.words.map((w) => w.endS))).toBeLessThanOrEqual(Number(p.format.duration) + 0.05);
  }, 240_000);

  it("then Cut clips is offered and accepted for it (an uploaded, prepared video counts as finished)", async () => {
    const id = await mk(await upload(70));
    expect(await loadClipsTab(db.pool, id)).toMatchObject({ canCut: false });
    expect(await requestClips(db.pool, queue, id)).toMatchObject({ ok: false });
    expect((await run(id, talker())).kind).toBe("committed");
    expect(await loadClipsTab(db.pool, id)).toMatchObject({ canCut: true });
    expect(await requestClips(db.pool, queue, id)).toMatchObject({ ok: true });
  }, 240_000);

  it("refuses a file that is not a plain video (a text file, a playlist naming another file) and deletes it", async () => {
    const txt = path.join(root, "tmp", "t.part");
    writeFileSync(txt, "this is not a video");
    const a = await mk(txt);
    expect((await run(a, talker())).kind).toBe("known_failure");
    expect(await errorOf(a)).toMatch(/could not be read as a video|not a plain video file/);
    expect(existsSync(path.join(root, "videos", a, "upload.bin"))).toBe(false);
    const pl = path.join(root, "tmp", "p.part");
    writeFileSync(pl, "#EXTM3U\n#EXT-X-TARGETDURATION:10\n#EXTINF:10,\n/etc/hosts\n#EXT-X-ENDLIST\n");
    const b = await mk(pl);
    expect((await run(b, talker())).kind).toBe("known_failure");
    expect(await latestContent(db.pool, b, "captions")).toBeNull();
    expect(existsSync(path.join(root, "videos", b, "final.mp4"))).toBe(false);
  }, 120_000);

  it("refuses a video that is too short, speech-to-text that fails, and a video with almost no speech, all in plain words and with nothing saved", async () => {
    const tiny = await mk(await upload(10));
    expect((await run(tiny, talker())).kind).toBe("known_failure");
    expect(await errorOf(tiny)).toMatch(/too short to cut clips from/);

    const broken = await mk(await upload(30));
    expect((await run(broken, { transcribe: async () => { throw new Error("VoiceStudio refused the request (409): it probably has no speech-to-text model installed."); } })).kind).toBe("known_failure");
    expect(await errorOf(broken)).toMatch(/Speech-to-text failed: VoiceStudio refused/);

    const quiet = await mk(await upload(30));
    expect((await run(quiet, { transcribe: async () => [{ word: "hi", startS: 1, endS: 1.2 }] })).kind).toBe("known_failure");
    expect(await errorOf(quiet)).toMatch(/Only 1 spoken words/);
    for (const v of [tiny, broken, quiet]) {
      expect(await latestContent(db.pool, v, "captions")).toBeNull();
      expect(existsSync(path.join(root, "videos", v, "upload.bin"))).toBe(false);
    }
  }, 360_000);
});
