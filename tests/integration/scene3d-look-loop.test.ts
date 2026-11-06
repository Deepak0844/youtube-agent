import type { LanguageModel } from "ai";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Message, ModelStep } from "@/server/core/agent-loop";
import { canonicalJson, sha256Hex } from "@/server/core/content-hash";
import { buildEngineConfig } from "@/server/core/engine-config";
import type { ModelRow } from "@/server/core/llm-catalog";
import { versionsKey, type GateInput } from "@/server/core/queue-input";
import { readSceneCodeBody, sceneCodeSha } from "@/server/core/scene3d-code-body";
import { readReview } from "@/server/core/scene3d-review";
import { readPreviews } from "@/server/core/scene3d-stills";
import type { StageHandler } from "@/server/core/stage-handler";
import { approvalReaders } from "@/server/db/approval-readers";
import { approveGate, liveGateHash } from "@/server/db/approvals";
import { readNextAction } from "@/server/db/pipeline";
import { decideGate, type Queues } from "@/server/db/queue-actions";
import { loadQueue, type GateItem } from "@/server/db/queue-data";
import { runStage } from "@/server/db/stage-runner-adapter";
import { insertQueuedStage } from "@/server/db/stages";
import { addContent, createVideoRow, latestContent } from "@/server/db/videos";
import { createLlmClient } from "@/server/llm/client";
import { createFakeImage } from "@/server/providers/media/fake";
import { createFakeRenderer } from "@/server/providers/renderer/fake";
import type { Scene3dStillsArgs, Scene3dStillsRenderer } from "@/server/providers/renderer";
import { createFakeVoice } from "@/server/providers/voice/fake";
import { withAttempt } from "@/worker/stages/attempt";
import type { StageDeps } from "@/worker/stages/deps";
import { scene3dAuthorAttempt } from "@/worker/stages/scene3d-author";
import { scene3dReviewAttempt } from "@/worker/stages/scene3d-review";
import { scene3dStillsAttempt } from "@/worker/stages/scene3d-stills";
import { ttsAttempt } from "@/worker/stages/tts";
import { fakeCatalog } from "../support/catalog3d";
import { withTestDb, type TestDb } from "../support/db";

// The automatic look loop of a scene3d_code video through the REAL engine hashes, with a FAKE model and a fake picture renderer that returns
// real PNGs (good, flat, white void, cropped) chosen by a marker comment in the scene source. No model, no render, no Docker.
let db: TestDb;
let root: string;
const nativeOn = buildEngineConfig(new Map<string, unknown>([["render.native_3d", true]]));
const SESSION_ID = "0190f3a2-7c1e-7a55-9d3b-2f6c8a1b4e92";
const actor = { kind: "session", sessionId: SESSION_ID } as const;
const queues: Queues = { stage: { enqueue: async (id, fence, seq) => `stage.${id}.${fence}.${seq}` }, upload: { enqueueUpload: async (id) => `upload.${id}` } };

beforeAll(async () => {
  db = await withTestDb();
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "scene3d-look-loop-")));
});
afterAll(async () => {
  rmSync(root, { recursive: true, force: true });
  await db?.stop();
});
beforeEach(async () => {
  await db.reset();
  await db.pool.query("insert into budgets (scope, cap_micro_usd) values ('draft_run', 3000000), ('video:scene_kit', 2000000), ('video:scene3d_code', 2000000), ('day', 15000000), ('month', 100000000)");
  await db.ownerPool.query("insert into sessions (id, token_hash, expires_at, absolute_expires_at) values ($1, 'loop-test', clock_timestamp() + interval '1 day', clock_timestamp() + interval '7 days')", [SESSION_ID]);
});

// ---- pictures: 540x960 PNGs -----------------------------------------------------------------------------------------------------------------
const W = 540, H = 960;
type Rgb = [number, number, number];
const noise = (x: number, y: number) => ((x * 7 + y * 13) % 9) - 4;
async function png(paint: (x: number, y: number) => Rgb): Promise<Buffer> {
  const d = Buffer.alloc(W * H * 3);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) d.set(paint(x, y), (y * W + x) * 3);
  return sharp(d, { raw: { width: W, height: H, channels: 3 } }).png().toBuffer();
}
const scenery = (subject: (x: number, y: number) => boolean) => (x: number, y: number): Rgb => {
  if (subject(x, y)) return [150 + noise(x, y) * 3, 60, 50 + (x % 40)];
  if (y < 480) return [110 + Math.floor(y / 8), 160 + Math.floor(y / 12), 215];
  return [90 + noise(x, y) * 4, 120 + (x % 30) + noise(y, x) * 3, 80];
};
let PICS: { good: Buffer; flat: Buffer; void: Buffer; crop: Buffer };
beforeAll(async () => {
  PICS = {
    good: await png(scenery((x, y) => x > 130 && x < 410 && y > 330 && y < 700)),
    flat: await png((x, y) => [40 + (noise(x, y) > 3 ? 1 : 0), 90, 140]),
    void: await png((x, y) => (x > 200 && x < 340 && y > 400 && y < 560 ? [190, 60, 40] : [252, 252, 252])),
    crop: await png(scenery((x, y) => x < 260 && y > 150 && y < 700)),
  };
});

/** A fake picture renderer: picture 1 is flat when the source says "flat", picture 2 a white void for "void", picture 3 cropped for "crop"; all others good. */
function fakeStills(): Scene3dStillsRenderer & { calls: Scene3dStillsArgs[] } {
  const calls: Scene3dStillsArgs[] = [];
  return {
    calls,
    stills: async (ctx, a) => {
      calls.push(a);
      const tags = /\/\/ look:([a-z ]*)/.exec(a.scene3dCode?.source ?? "")?.[1]?.split(" ") ?? [];
      mkdirSync(path.join(ctx.attemptDir, "stills"), { recursive: true });
      const files = a.frames.map((_, i) => `stills/${String(i + 1).padStart(2, "0")}.png`);
      files.forEach((f, i) => writeFileSync(path.join(ctx.attemptDir, f), i === 0 && tags.includes("flat") ? PICS.flat : i === 1 && tags.includes("void") ? PICS.void : i === 2 && tags.includes("crop") ? PICS.crop : PICS.good));
      return { files, image: "fake" };
    },
  };
}

// ---- model ----------------------------------------------------------------------------------------------------------------------------------
const ROW: ModelRow = { id: "00000000-0000-4000-8000-0000000000bb", provider: "anthropic", modelId: "m", label: "Fake", baseUrl: null, prices: { inputPerMTokMicro: 1_000_000, outputPerMTokMicro: 1_000_000 }, isFree: false, capabilities: { structuredOutput: true, toolUse: true, vision: false, nativeWebSearch: false, contextWindow: 128000 }, enabled: true, endpointKind: "hosted" };
const seen: Message[][] = []; // the messages of every author call, in order
/** A model that answers the author calls from `replies`, one each, in order; asking for more than planned is an error (so a loop that does not stop shows up). */
function llmWith(replies: string[]) {
  let n = 0;
  const step: ModelStep = async (messages) => {
    seen.push(messages.map((m) => ({ ...m })));
    const text = replies[n++];
    if (text === undefined) throw new Error("the model was asked more often than the test planned");
    return { text, toolCalls: [], usage: { inputTokens: 100, outputTokens: 50 } };
  };
  return (scopes: string[]) => createLlmClient({ db: db.pool, catalog: { route: async () => ROW, localServices: async () => [] }, getKey: async () => null, buildModel: () => ({}) as LanguageModel, budgetScopes: () => scopes, makeStep: () => step });
}
const GOOD = (tag: string, n = 0) => "```tsx\n" + `import { World, CameraRig, Finish, Hero, useModels } from "s3k";
import type { SceneProps } from "s3k";
// look:${tag}
// variant ${n}
const SHIP = "pp_ship";

export default function Scene({ resolver }: SceneProps) {
  const models = useModels([SHIP], resolver);
  if (!models) return null;
  return (
    <>
      <World focus={{ min: [-10, 0, -10], max: [10, 10, 10] }} ground={{ y: 0 }} sea={false} />
      <Hero><primitive object={models.get(SHIP, { size: 12 })} /></Hero>
      <CameraRig shots={[{ t: 0, at: [30, 12, 30], look: [0, 3, 0] }, { t: 10, at: [-30, 12, 30], look: [0, 3, 0] }]} floor={1} />
      <Finish />
    </>
  );
}
` + "```";
const sourceOf = (reply: string) => reply.replace(/^```tsx\n/, "").replace(/\n```$/, "\n");

const IDS = ["hook", "setup", "dig", "load", "pour", "reveal", "loop"];
const line = (id: string) => Array.from({ length: 14 }, (_, i) => `${id}${i}`).join(" ");
const STORY = IDS.map((id) => ({ id, visual: `${id} visual`, line: line(id) }));
async function codeVideo(): Promise<string> {
  const v = await createVideoRow(db.pool, { format: "short", kind: "scene3d_code", language: "en", topic: "How Dubai made land from the sea" });
  const script = { title: "Land from the sea", narration: STORY.map((b) => b.line).join(" "), story: STORY };
  await addContent(db.pool, v.id, "script", { body: script, sha256: sha256Hex(canonicalJson(script)) });
  const beats = { beats: IDS.map((id) => ({ id, text: line(id) })) };
  await addContent(db.pool, v.id, "beats", { body: beats, sha256: sha256Hex(canonicalJson(beats)) });
  const live = await liveGateHash(db.pool, v.id, "script");
  expect((await approveGate(db.pool, { videoId: v.id, gate: "script", seenHash: live!.hash, actor })).ok).toBe(true);
  return v.id;
}

// ---- the engine driver: run whatever the pipeline asks for, with the hash it asks for, until it waits at a gate ------------------------------
function mkDeps(over: Partial<StageDeps>): StageDeps {
  const voice = createFakeVoice();
  return { db: db.pool, root, voiceFor: async (a: { budgetScopes: string[] }) => ({ provider: voice.forScopes(a.budgetScopes), providerId: "fake", voice: "fake" }), image: createFakeImage(), renderer: createFakeRenderer(), catalog3d: async () => fakeCatalog(), ...over } as never;
}
const noProvider = { call: async () => Promise.reject(new Error("no provider in handler mode")) };
const ready = async () => ({ ready: true, message: "Ready" });
const fin = () => ({ db: db.pool, root });

interface Rig { llm: ReturnType<typeof llmWith>; stills: ReturnType<typeof fakeStills>; ran: string[] }
function rig(replies: string[]): Rig {
  seen.length = 0;
  return { llm: llmWith(replies), stills: fakeStills(), ran: [] };
}
/** Runs what the pipeline asks for until it waits at a gate (returns the gate) or is about to run `stopBefore` (returns "stopped"). */
async function drive(id: string, r: Rig, stopBefore?: string): Promise<string> {
  const handlers: Record<string, StageHandler> = {
    draft: async () => ({}), // the script was seeded and approved by hand (codeVideo), so the draft step has nothing left to do
    tts: withAttempt(fin(), ttsAttempt(mkDeps({}))),
    scene3d_author: withAttempt(fin(), scene3dAuthorAttempt(mkDeps({ makeLlm: r.llm }))),
    scene3d_stills: withAttempt(fin(), scene3dStillsAttempt(mkDeps({ native: { renderer: createFakeRenderer(), stills: r.stills, ready } }))),
    scene3d_review: withAttempt(fin(), scene3dReviewAttempt(mkDeps({}))),
  };
  await db.pool.query("update videos set status = 'active' where id = $1", [id]);
  for (let i = 0; i < 40; i++) {
    const a = await readNextAction(db.pool, id, approvalReaders);
    if (a?.kind === "wait_gate") {
      await db.pool.query("update videos set status = 'waiting' where id = $1", [id]);
      return a.gate;
    }
    if (stopBefore && (a?.kind === "enqueue" || a?.kind === "wait_stage") && a.stage === stopBefore) return "stopped";
    let stageRunId: string, inputHash: string, name: string;
    if (a?.kind === "enqueue") {
      name = a.stage;
      inputHash = a.inputHash;
      stageRunId = await insertQueuedStage(db.pool, { videoId: id, name, inputHash });
    } else if (a?.kind === "wait_stage" && a.status === "queued") {
      name = a.stage;
      const q = (await db.pool.query<{ id: string; input_hash: string }>("select id, input_hash from stage_runs where video_id = $1 and name = $2 and status = 'queued' order by created_at desc limit 1", [id, name])).rows[0]!;
      stageRunId = q.id;
      inputHash = q.input_hash;
    } else throw new Error(`pipeline stuck: ${JSON.stringify(a)}`);
    const handler = handlers[name];
    if (!handler) throw new Error(`no handler for ${name}`);
    r.ran.push(name);
    const out = await runStage(db.pool, { provider: noProvider, ttlMs: 60_000, workerId: "w1", handler, config: nativeOn }, { stageRunId, inputHash });
    if (out.kind !== "committed") throw new Error(`${name}: ${out.kind} ${JSON.stringify((await db.pool.query("select result from stage_runs where id = $1", [stageRunId])).rows[0])}`);
  }
  throw new Error("never reached a gate");
}
const reviews = async (id: string) => (await db.pool.query<{ body: unknown }>("select body from video_content where video_id = $1 and kind = 'review' order by version", [id])).rows.map((x) => readReview(x.body)!);
const authorCalls = () => seen.length;
const promptText = (m: Message[]) => m.map((x) => (typeof x.content === "string" ? x.content : JSON.stringify(x.content))).join("\n");
const sceneNow = async (id: string) => readSceneCodeBody((await latestContent(db.pool, id, "scenes"))!.body)!;
const lookInput = async (id: string, note?: string): Promise<GateInput> => {
  const live = await liveGateHash(db.pool, id, "look");
  return { videoId: id, gate: "look", seenHash: live!.hash, seenVersions: versionsKey(live!.versions), note };
};

describe("the automatic look loop (scene3d_code)", () => {
  it("revises a bad first draft with the app's own sentences, re-runs author > pictures > review by hash, and stops when the checks pass", async () => {
    const id = await codeVideo();
    const r = rig([GOOD("flat void", 0), GOOD("flat", 1), GOOD("", 2)]);
    expect(await drive(id, r)).toBe("look");
    expect(r.ran).toEqual(["draft", "tts", "scene3d_author", "scene3d_stills", "scene3d_review", "scene3d_author", "scene3d_stills", "scene3d_review", "scene3d_author", "scene3d_stills", "scene3d_review"]);
    expect(authorCalls()).toBe(3);
    // round 1 sees round 0's measured problems (our sentences), fenced as data, plus the previous file
    expect(promptText(seen[0]!)).not.toMatch(/measured problems/);
    const second = promptText(seen[1]!);
    expect(second).toMatch(/automatic revision round 1 of 3/);
    expect(second).toMatch(/BEGIN_DATA measured problems \(written by the app\)\n1\. Frame 1 is almost one flat colour/);
    expect(second).toMatch(/2\. Frames? 2 shows? mostly empty white background/);
    expect(second).toMatch(/BEGIN_DATA your previous scene\.tsx[^\n]*\nimport \{ World/);
    expect(promptText(seen[2]!)).toMatch(/automatic revision round 2 of 3/);
    const rs = await reviews(id);
    expect(rs.map((x) => [x.round, x.problems.length, x.revise])).toEqual([[0, 2, true], [1, 1, true], [2, 0, false]]);
    expect(rs[2]).toMatchObject({ passed: true, stop_reason: "passed", best_round: 2 });
    const body = await sceneNow(id);
    expect(body.source).toBe(sourceOf(GOOD("", 2)));
    expect(readPreviews((await latestContent(db.pool, id, "previews"))!.body)!.scene_sha256).toBe(sceneCodeSha(body.source, body.props));
    expect(readFileSync(path.join(root, "videos", id, "scene.tsx"), "utf8")).toBe(body.source);
  }, 180_000);

  it("never loops forever: after 3 automatic revisions the owner gets the look with the remaining problems", async () => {
    const id = await codeVideo();
    const r = rig([GOOD("flat void crop", 0), GOOD("flat void crop", 1), GOOD("flat void crop", 2), GOOD("flat void crop", 3), GOOD("", 4)]);
    expect(await drive(id, r)).toBe("look");
    expect(authorCalls()).toBe(4); // the first draft plus exactly 3 revisions; the fifth reply is never asked for
    const rs = await reviews(id);
    expect(rs.map((x) => x.round)).toEqual([0, 1, 2, 3]);
    expect(rs.at(-1)).toMatchObject({ revise: false, stop_reason: "max_rounds", passed: false });
    expect(rs.at(-1)!.problems).toHaveLength(3);
    expect(r.stills.calls).toHaveLength(4);
    const item = (await loadQueue(db.pool)).items.find((i): i is GateItem => i.kind === "gate" && i.videoId === id)!;
    if (item.content.kind !== "look" || !item.content.review) throw new Error("expected a look with a review");
    expect(item.content.review).toMatchObject({ rounds: 3, remainingCount: 3, firstFound: 3, fixed: 0, stopReason: "max_rounds" });
    expect(item.content.review.remaining[0]).toMatch(/flat colour/);
  }, 180_000);

  it("keeps the BETTER round: a worse last round is replaced by the best earlier scene, and the owner is shown its pictures", async () => {
    const id = await codeVideo();
    const r = rig([GOOD("flat void crop", 0), GOOD("flat", 1), GOOD("flat void", 2), GOOD("flat void crop", 3)]);
    expect(await drive(id, r)).toBe("look");
    expect(authorCalls()).toBe(4);
    const body = await sceneNow(id);
    expect(body.source).toBe(sourceOf(GOOD("flat", 1))); // round 1 had one problem: the best
    expect(readFileSync(path.join(root, "videos", id, "scene.tsx"), "utf8")).toBe(body.source);
    const p = readPreviews((await latestContent(db.pool, id, "previews"))!.body)!;
    expect(p.scene_sha256).toBe(sceneCodeSha(body.source, body.props)); // the pictures belong to the scene Render would draw
    const rs = await reviews(id);
    const last = rs.at(-1)!;
    expect(last).toMatchObject({ round: 3, revise: false, best_round: 1, restore_sha256: null }); // confirmation review of the restored scene
    expect(last.problems).toHaveLength(1);
    expect(r.ran.slice(-5)).toEqual(["scene3d_author", "scene3d_stills", "scene3d_review", "scene3d_stills", "scene3d_review"]); // put back, drawn again, confirmed
    expect(authorCalls()).toBe(4); // the put-back did not ask the model for anything
    const item = (await loadQueue(db.pool)).items.find((i): i is GateItem => i.kind === "gate" && i.videoId === id)!;
    if (item.content.kind !== "look" || !item.content.review) throw new Error("expected a look with a review");
    expect(item.content.review).toMatchObject({ shownRound: 1, firstFound: 3, remainingCount: 1, fixed: 2 });
  }, 180_000);

  it("stops when the money left for this video cannot pay for another author call", async () => {
    const id = await codeVideo();
    const r = rig([GOOD("flat", 0), GOOD("", 1)]);
    expect(await drive(id, r, "scene3d_review")).toBe("stopped"); // narrated, authored, pictures drawn; the review is next
    expect(r.ran).toEqual(["draft", "tts", "scene3d_author", "scene3d_stills"]);
    await db.pool.query("update budgets set cap_micro_usd = 1000 where scope = $1", [`video:${id}`]); // far below one author call
    expect(await drive(id, r)).toBe("look");
    expect(seen).toHaveLength(1);
    const rs = await reviews(id);
    expect(rs).toHaveLength(1);
    expect(rs[0]).toMatchObject({ round: 0, revise: false, stop_reason: "budget", passed: false });
  }, 180_000);

  it("an owner send-back re-runs the author with the note (fenced), restarts the automatic rounds, and is capped at 3", async () => {
    const id = await codeVideo();
    const r = rig([GOOD("flat", 0), GOOD("", 1), GOOD("", 2), GOOD("flat", 3), GOOD("", 4), GOOD("", 5)]);
    expect(await drive(id, r)).toBe("look"); // round 0 flat, round 1 clean
    expect(authorCalls()).toBe(2);
    const sent = await decideGate(db.pool, queues, actor, await lookInput(id, "make the ship bigger"), "send_back");
    expect(sent).toMatchObject({ ok: true });
    expect(sent.message).not.toMatch(/director/);
    expect(await drive(id, r)).toBe("look");
    expect(authorCalls()).toBe(3);
    const text = promptText(seen[2]!);
    expect(text).toMatch(/BEGIN_DATA owner's note on the previous look\nmake the ship bigger\nEND_DATA/);
    expect(text).toMatch(/BEGIN_DATA your previous scene\.tsx/);
    expect(text).not.toMatch(/measured problems/); // this review is from before the send-back: not active
    let rs = await reviews(id);
    expect(rs.at(-1)).toMatchObject({ round: 0, look_count: 1, passed: true });
    // a second send-back whose new scene is flat: the rounds restart from 0 again (3 fresh tries)
    expect((await decideGate(db.pool, queues, actor, await lookInput(id, "now the sea"), "send_back")).ok).toBe(true);
    expect(await drive(id, r)).toBe("look");
    rs = await reviews(id);
    expect(rs.slice(-2).map((x) => [x.look_count, x.round, x.revise])).toEqual([[2, 0, true], [2, 1, false]]);
    expect(promptText(seen[4]!)).toMatch(/automatic revision round 1 of 3/);
    expect(promptText(seen[4]!)).toMatch(/BEGIN_DATA owner's note on the previous look\nnow the sea\nEND_DATA/);
    // the third is allowed, the fourth is refused with the plain cap message and records nothing
    expect((await decideGate(db.pool, queues, actor, await lookInput(id, "third"), "send_back")).ok).toBe(true);
    expect(await drive(id, r)).toBe("look");
    const fourth = await decideGate(db.pool, queues, actor, await lookInput(id, "fourth"), "send_back");
    expect(fourth.ok).toBe(false);
    expect(fourth.message).toMatch(/already sent this look back 3 times/);
    expect((await db.pool.query("select count(*)::int as n from approvals where video_id = $1 and gate = 'look' and decision = 'sent_back'", [id])).rows[0].n).toBe(3);
  }, 240_000);
});
