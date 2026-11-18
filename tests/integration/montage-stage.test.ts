import { copyFileSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { systemRightsText } from "@/server/core/asset-rules";
import { buildEngineConfig } from "@/server/core/engine-config";
import { canonicalJson, sha256Hex } from "@/server/core/content-hash";
import { uuidv7 } from "@/server/core/ids";
import type { StageHandler } from "@/server/core/stage-handler";
import type { StageOutcome } from "@/server/core/stage-runner";
import { approveGate, liveGateHash } from "@/server/db/approvals";
import { registerAsset } from "@/server/db/assets";
import { runStage } from "@/server/db/stage-runner-adapter";
import { insertQueuedStage } from "@/server/db/stages";
import { linkAsset } from "@/server/db/video-assets";
import { addContent, createVideoRow, latestContent } from "@/server/db/videos";
import { fakeDraft } from "@/server/llm/fake-step";
import type { ClipRenderInput } from "@/server/providers/renderer/clip-render";
import { runChild, type ChildSpec } from "@/server/render/child";
import { withAttempt } from "@/worker/stages/attempt";
import type { StageDeps } from "@/worker/stages/deps";
import { montageAttempt } from "@/worker/stages/montage";
import { withTestDb, type TestDb } from "../support/db";
import { assertFfprobeAvailable } from "../support/tools";

// Montage (M3): the `montage` stage edits the footage linked to each beat into one graded 1080x1920 film as long as the narration (real ffmpeg), then draws
// the captions (a fake of the locked renderer here). A beat with no footage, a clip that is too short, or one clip on two beats fails with a plain sentence.

let db: TestDb;
let root: string;
const SESSION = { kind: "session", sessionId: "11111111-1111-4111-8111-111111111111" } as const;
beforeAll(async () => {
  assertFfprobeAvailable();
  db = await withTestDb();
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "montage-stage-")));
});
afterAll(async () => {
  rmSync(root, { recursive: true, force: true });
  await db?.stop();
});
beforeEach(async () => {
  await db.reset();
});

const ff = (args: string[]) => {
  const r = spawnSync("ffmpeg", ["-v", "error", "-y", ...args]);
  if (r.status !== 0) throw new Error(String(r.stderr));
};
const noProvider = { call: async () => Promise.reject(new Error("no provider in handler mode")) };
async function play(videoId: string, handler: StageHandler): Promise<StageOutcome> {
  const inputHash = `h-montage-${uuidv7()}`;
  const stageRunId = await insertQueuedStage(db.pool, { videoId, name: "montage", inputHash });
  return runStage(db.pool, { provider: noProvider, ttlMs: 60_000, workerId: "w1", handler, config: buildEngineConfig(new Map()) }, { stageRunId, inputHash });
}

const NARRATION_S = 12;
const beatText = "Rain taps the window while the night train slowly leaves the quiet station behind it.";
const BEATS = [
  { id: "b1", text: beatText, visual: "night train platform", search: ["night train platform"] },
  { id: "b2", text: beatText, visual: "rain on a window", search: ["rain window"] },
  { id: "b3", text: beatText, visual: "city lights", search: ["city lights"] },
];

async function seedVideo(): Promise<string> {
  const v = await createVideoRow(db.pool, { format: "short", kind: "montage", language: "en", topic: "night trains" });
  const d = fakeDraft("en") as { title: string; narration: string };
  const script = { title: d.title, narration: d.narration };
  await addContent(db.pool, v.id, "script", { body: script, sha256: sha256Hex(canonicalJson(script)) });
  const beats = { beats: BEATS };
  await addContent(db.pool, v.id, "beats", { body: beats, sha256: sha256Hex(canonicalJson(beats)) });
  const live = await liveGateHash(db.pool, v.id, "script");
  const ok = await approveGate(db.pool, { videoId: v.id, gate: "script", seenHash: live!.hash, actor: SESSION });
  if (!ok.ok) throw new Error(ok.reason);
  const dir = path.join(root, "videos", v.id);
  mkdirSync(dir, { recursive: true });
  ff(["-f", "lavfi", "-i", `sine=frequency=300:duration=${NARRATION_S}`, path.join(dir, "narration.wav")]);
  const nar = { file: "narration.wav" };
  await addContent(db.pool, v.id, "narration", { body: nar, sha256: sha256Hex(canonicalJson(nar)) });
  const words = Array.from({ length: NARRATION_S * 3 }, (_, i) => ({ word: `w${i}`, startS: i / 3, endS: i / 3 + 0.3 }));
  const caps = { timings_kind: "aligned", words, needs_check: false, flags: [], approximate: false };
  await addContent(db.pool, v.id, "captions", { body: caps, sha256: sha256Hex(canonicalJson(caps)) });
  return v.id;
}

/** A footage asset: a real small mp4 in the asset folder, registered and linked to a beat. Returns the asset id. */
async function footage(videoId: string, beatId: string, o: { seconds?: number; seed?: string; assetId?: string } = {}): Promise<string> {
  let assetId = o.assetId;
  if (!assetId) {
    const rel = `assets/${uuidv7()}`;
    mkdirSync(path.join(root, rel), { recursive: true });
    const seconds = o.seconds ?? 9;
    ff(["-f", "lavfi", "-i", `testsrc=s=320x180:r=24:d=${seconds}`, "-pix_fmt", "yuv420p", path.join(root, rel, "main.mp4")]);
    const client = await db.pool.connect();
    try {
      const reg = await registerAsset(client, {
        kind: "video", originalName: "pixabay-x.mp4", mime: "video/mp4", bytes: 1000, width: 320, height: 180, durationS: seconds, sha256: sha256Hex(o.seed ?? uuidv7()), storageRef: `${rel}/main.mp4`, derivedRefs: {},
        tags: ["stock", "pixabay", "clip"], caption: "night train", source: "stock", rights: { attestations: [{ at: new Date().toISOString(), by: "system", text: systemRightsText("Pixabay Content License", "Pixabay") }] }, containsPerson: false,
      });
      assetId = reg.asset.id;
    } finally {
      client.release();
    }
  }
  await linkAsset(db.pool, { videoId, assetId, beatId, credit: "Video by A on Pixabay", sourceUrl: null, licence: "Pixabay Content License", briefHash: "h" });
  return assetId;
}

function deps(): StageDeps {
  return { db: db.pool, root, mix: { runChild: (spec: ChildSpec) => runChild(spec), audioRoot: root } } as unknown as StageDeps;
}
const fakeRender = (seen: ClipRenderInput[] = []) => async (ctx: { attemptDir: string }, input: ClipRenderInput) => {
  seen.push(input);
  const outPath = path.join(ctx.attemptDir, input.outFile);
  copyFileSync(input.clipFile, outPath);
  return { ok: true as const, outPath, image: "fake-image" };
};
const probe = (f: string) => JSON.parse(spawnSync("ffprobe", ["-v", "error", "-show_entries", "stream=width,height:format=duration", "-of", "json", f], { encoding: "utf8" }).stdout) as { streams: { width?: number; height?: number }[]; format: { duration: string } };
const failure = async (id: string, o: StageOutcome) => {
  if (o.kind === "committed") return "";
  expect(o.kind).toBe("known_failure");
  return (await db.pool.query<{ result: { error: string } }>("select result from stage_runs where video_id = $1 and name = 'montage'", [id])).rows[0]!.result.error;
};

describe("montage stage", () => {
  it("edits one clip per beat into a 1080x1920 film as long as the narration, with captions and a licence record", async () => {
    const id = await seedVideo();
    for (const b of BEATS) await footage(id, b.id);
    const seen: ClipRenderInput[] = [];
    const out = await play(id, withAttempt({ db: db.pool, root }, montageAttempt(deps(), { render: fakeRender(seen) })));
    expect(out.kind, await failure(id, out)).toBe("committed");
    const file = path.join(root, "videos", id, "render.mp4");
    expect(existsSync(file)).toBe(true);
    const p = probe(file);
    expect(p.streams.find((s) => s.width)).toMatchObject({ width: 1080, height: 1920 });
    expect(Math.abs(Number(p.format.duration) - NARRATION_S)).toBeLessThan(0.7);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.captions.length).toBeGreaterThan(30);
    const rec = (await latestContent(db.pool, id, "footage"))!.body as { picks: { slotId: string; credit: string | null }[] };
    expect(rec.picks.map((x) => x.slotId)).toEqual(["b1", "b2", "b3"]);
    expect(rec.picks[0]!.credit).toBe("Video by A on Pixabay");
  }, 180_000);

  it("grades the film the way the owner chose, and with film when none was chosen", async () => {
    const run = async (grade: string | null) => {
      const id = await seedVideo();
      if (grade) await db.pool.query("update videos set grade = $2 where id = $1", [id, grade]);
      for (const b of BEATS) await footage(id, b.id);
      const args: string[] = [];
      const d = { ...deps(), mix: { runChild: (spec: ChildSpec) => (args.push(...spec.args), runChild(spec)), audioRoot: root } } as unknown as StageDeps;
      const out = await play(id, withAttempt({ db: db.pool, root }, montageAttempt(d, { render: fakeRender() })));
      expect(out.kind, await failure(id, out)).toBe("committed");
      return args.join(" ");
    };
    expect(await run("mono")).toContain("hue=s=0");
    expect(await run(null)).toContain("colorbalance=rs=0.03:bs=-0.03"); // film
  }, 240_000);

  it("fails naming the beat that has no footage", async () => {
    const id = await seedVideo();
    await footage(id, "b1");
    await footage(id, "b3");
    const out = await play(id, withAttempt({ db: db.pool, root }, montageAttempt(deps(), { render: fakeRender() })));
    expect(await failure(id, out)).toMatch(/No footage was found for beat b2/);
  }, 120_000);

  it("never puts one clip on two beats", async () => {
    const id = await seedVideo();
    const a = await footage(id, "b1");
    await footage(id, "b2", { assetId: a });
    await footage(id, "b3");
    const out = await play(id, withAttempt({ db: db.pool, root }, montageAttempt(deps(), { render: fakeRender() })));
    expect(await failure(id, out)).toMatch(/same clip is on two beats/);
  }, 120_000);

  it("refuses a clip shorter than its beat", async () => {
    const id = await seedVideo();
    await footage(id, "b1");
    await footage(id, "b2", { seconds: 1 });
    await footage(id, "b3");
    const out = await play(id, withAttempt({ db: db.pool, root }, montageAttempt(deps(), { render: fakeRender() })));
    expect(await failure(id, out)).toMatch(/clip for beat b2 is 1\.0 s/);
  }, 120_000);
});
