import type { LanguageModel } from "ai";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { canonicalJson, sha256Hex } from "@/server/core/content-hash";
import { buildEngineConfig } from "@/server/core/engine-config";
import { uuidv7 } from "@/server/core/ids";
import type { ModelRow } from "@/server/core/llm-catalog";
import { KnownFailure } from "@/server/core/paid-call";
import { validateScript } from "@/server/core/script-contract";
import type { StageHandler } from "@/server/core/stage-handler";
import type { StageOutcome } from "@/server/core/stage-runner";
import { approveGate, liveGateHash } from "@/server/db/approvals";
import { saveDraftContent } from "@/server/db/draft-store";
import { runStage } from "@/server/db/stage-runner-adapter";
import { claimStage, insertQueuedStage } from "@/server/db/stages";
import { addContent, createVideoRow, latestContent } from "@/server/db/videos";
import { createLlmClient } from "@/server/llm/client";
import { fakeModelStep } from "@/server/llm/fake-step";
import { createFakeImage } from "@/server/providers/media/fake";
import { createFakeRenderer } from "@/server/providers/renderer/fake";
import type { RenderArgs, Renderer } from "@/server/providers/renderer";
import { createFakeVoice } from "@/server/providers/voice/fake";
import { validateScene3d } from "@/shared/scene3d";
import { withAttempt } from "@/worker/stages/attempt";
import { buildAttempt } from "@/worker/stages/build";
import type { StageDeps } from "@/worker/stages/deps";
import { directScene3dAttempt } from "@/worker/stages/direct-scene3d";
import { renderAttempt } from "@/worker/stages/render";
import { ttsAttempt } from "@/worker/stages/tts";
import { fakeCatalog } from "../support/catalog3d";
import { withTestDb, type TestDb } from "../support/db";

// The scene3d kind through the director and Render on a fake model and fake renderers (no real render, no Docker).
let db: TestDb;
let root: string;
const config = buildEngineConfig(new Map());
const nativeOn = buildEngineConfig(new Map<string, unknown>([["render.native_3d", true]]));
const SESSION = { kind: "session", sessionId: "11111111-1111-4111-8111-111111111111" } as const;
const GOOD_MP4 = path.resolve(process.cwd(), "tests/fixtures/video/good.mp4");

beforeAll(async () => {
  db = await withTestDb();
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "scene3d-stage-")));
});
afterAll(async () => {
  rmSync(root, { recursive: true, force: true });
  await db?.stop();
});
beforeEach(async () => {
  await db.reset();
  await db.pool.query("insert into budgets (scope, cap_micro_usd) values ('draft_run', 3000000), ('video:scene_kit', 2000000), ('video:scene3d', 2000000), ('day', 15000000), ('month', 100000000)");
});

const ROW: ModelRow = { id: "00000000-0000-4000-8000-0000000000bb", provider: "anthropic", modelId: "m", label: "Fake", baseUrl: null, prices: { inputPerMTokMicro: 1_000_000, outputPerMTokMicro: 1_000_000 }, isFree: false, capabilities: { structuredOutput: true, toolUse: true, vision: false, nativeWebSearch: false, contextWindow: 128000 }, enabled: true, endpointKind: "hosted" };
const llmWith = (texts: string[]) => {
  const step = fakeModelStep({ script: texts.map((text) => ({ text, toolCalls: [], usage: { inputTokens: 100, outputTokens: 50 } })) });
  return (scopes: string[]) => createLlmClient({ db: db.pool, catalog: { route: async () => ROW, localServices: async () => [] }, getKey: async () => null, buildModel: () => ({}) as LanguageModel, budgetScopes: () => scopes, makeStep: () => step });
};

function mkDeps(over: Partial<StageDeps>): StageDeps {
  const voice = createFakeVoice();
  return { db: db.pool, root, voiceFor: async (a: { budgetScopes: string[] }) => ({ provider: voice.forScopes(a.budgetScopes), providerId: "fake", voice: "fake" }), image: createFakeImage(), renderer: createFakeRenderer(), catalog3d: async () => fakeCatalog(), ...over } as never;
}

const noProvider = { call: async () => Promise.reject(new Error("no provider in handler mode")) };
async function play(videoId: string, name: string, handler: StageHandler, cfg = config): Promise<StageOutcome> {
  const inputHash = `h-${name}-${uuidv7()}`;
  const stageRunId = await insertQueuedStage(db.pool, { videoId, name, inputHash });
  return runStage(db.pool, { provider: noProvider, ttlMs: 60_000, workerId: "w1", handler, config: cfg }, { stageRunId, inputHash });
}

const IDS = ["hook", "setup", "dig", "load", "pour", "reveal", "loop"];
const VISUALS: Record<string, string> = {
  hook: "A tall skyline rises over the sea",
  setup: "A cargo ship floats beside a rock wall",
  dig: "Workers stand on the sand",
  load: "A crane lifts rocks onto a truck",
  pour: "Sand pours into the water",
  reveal: "A palm tree stands on the new land",
  loop: "The camera rises back to the skyline",
};
const line = (id: string) => Array.from({ length: 14 }, (_, i) => `${id}${i}`).join(" ");
const STORY = IDS.map((id) => ({ id, visual: VISUALS[id]!, line: line(id) }));
const NARRATION = STORY.map((b) => b.line).join(" ");

const sceneJson = (over: { elements?: unknown[]; focus?: string } = {}) => ({
  version: 2,
  elements: over.elements ?? [
    { kind: "water", id: "sea", size_m: [400, 200] },
    { kind: "model", id: "barge", model: { catalog: "pp_ship" }, height_m: 20 },
    { kind: "sand_pile", id: "mound", radius_m: 10, height_m: 4, animations: [{ type: "pour", from: [0, 10, 0], start_s: 2, duration_s: 10 }] },
  ],
  shots: IDS.map((id) => ({ id, duration_s: 8, focus: over.focus ?? "barge", caption: id })),
});
const GOOD = JSON.stringify({ scene: sceneJson(), missing_assets: [] });
const GOOD_MISSING = JSON.stringify({ scene: sceneJson(), missing_assets: [{ beat: "dig", wanted: "an excavator", substitute: "a dump truck" }] });
const UNKNOWN_ID = JSON.stringify({ scene: sceneJson({ elements: [{ kind: "model", id: "x", model: { catalog: "pp_unicorn" }, height_m: 3 }], focus: "x" }), missing_assets: [] });

/** A scene3d video with an approved script (narration + story). */
async function scene3dVideo(story: unknown = STORY): Promise<string> { // pass null for a script with no story
  const v = await createVideoRow(db.pool, { format: "short", kind: "scene3d", language: "en", topic: "How Dubai made land from the sea" });
  const script = { title: "Land from the sea", narration: NARRATION, ...(story === null ? {} : { story }) };
  await addContent(db.pool, v.id, "script", { body: script, sha256: sha256Hex(canonicalJson(script)) });
  const beats = { beats: IDS.map((id) => ({ id, text: line(id) })) };
  await addContent(db.pool, v.id, "beats", { body: beats, sha256: sha256Hex(canonicalJson(beats)) });
  const live = await liveGateHash(db.pool, v.id, "script");
  const ok = await approveGate(db.pool, { videoId: v.id, gate: "script", seenHash: live!.hash, actor: SESSION });
  if (!ok.ok) throw new Error(ok.reason);
  return v.id;
}

const direct = (texts: string[]) => withAttempt({ db: db.pool, root }, directScene3dAttempt(mkDeps({ makeLlm: llmWith(texts) })));
const stageRow = async (id: string, name: string) => (await db.pool.query("select status, result from stage_runs where video_id = $1 and name = $2 order by created_at desc limit 1", [id, name])).rows[0] as { status: string; result: Record<string, unknown> };

/** A renderer that records its call and copies a real mp4 like the real renderers' output. */
function capture(): Renderer & { calls: RenderArgs[] } {
  const calls: RenderArgs[] = [];
  const fake = createFakeRenderer({ fixture: GOOD_MP4 });
  return { calls, render: (ctx, a) => (calls.push(a), fake.render(ctx, a)) };
}

describe("scene3d: draft evidence", () => {
  it("a story fact becomes an evidence claim saved with the draft, and the story is kept in the script", async () => {
    const v = await createVideoRow(db.pool, { format: "short", kind: "scene3d", language: "en", topic: "t" });
    const stageId = await insertQueuedStage(db.pool, { videoId: v.id, name: "draft", inputHash: "h" });
    const claim = (await claimStage(db.pool, { id: stageId, inputHash: "h", workerId: "w1", ttlMs: 600_000 }))!;
    const story = STORY.map((b, i) => (i === 2 ? { ...b, fact: "The island is 5 km wide", source_url: "https://a.test/i", quote: "the island is five km wide" } : b));
    const checked = validateScript({ title: "Land", narration: NARRATION, beats: IDS.map((id) => ({ id })), evidence: [], story }, "en", "short", { kind: "scene3d" });
    if (!checked.ok) throw new Error(checked.problems.join());
    await saveDraftContent(db.pool, v.id, claim, checked.script);
    const evidence = (await latestContent(db.pool, v.id, "evidence"))!.body as { claims: Array<{ text: string; kind: string }> };
    expect(evidence.claims.map((c) => [c.text, c.kind])).toEqual([["The island is 5 km wide", "sourced"]]);
    expect(((await latestContent(db.pool, v.id, "script"))!.body as { story: unknown[] }).story).toHaveLength(7);
  });
});

describe("scene3d: director stage", () => {
  it("retries a bad answer with the checker's sentences, then saves the scene and its missing_assets as scenes content", async () => {
    const id = await scene3dVideo();
    const out = await play(id, "direct_scene3d", direct(["not json", GOOD_MISSING]));
    expect(out.kind).toBe("committed");
    const saved = (await latestContent(db.pool, id, "scenes"))!.body as { kind: string; scene: unknown; missing_assets: unknown };
    expect(saved.kind).toBe("scene3d");
    expect(validateScene3d(saved.scene).ok).toBe(true);
    expect(saved.missing_assets).toEqual([{ beat: "dig", wanted: "an excavator", substitute: "a dump truck" }]);
    expect(existsSync(path.join(root, "videos", id, "scene3d.json"))).toBe(true);
    expect((await stageRow(id, "direct_scene3d")).result).toMatchObject({ kind: "scene3d", attempts: 2, shots: 7, models: 1, missing_assets: 1 });
    expect(await latestContent(db.pool, id, "cost_plan")).toBeNull(); // nothing to buy
  });

  it("stores an empty missing_assets list when every visual was matched", async () => {
    const id = await scene3dVideo();
    expect((await play(id, "direct_scene3d", direct([GOOD]))).kind).toBe("committed");
    expect(((await latestContent(db.pool, id, "scenes"))!.body as { missing_assets: unknown[] }).missing_assets).toEqual([]);
  });

  it("an unknown catalogue id is rejected each time, and after three attempts the stage fails clearly and keeps the kind", async () => {
    const id = await scene3dVideo();
    const out = await play(id, "direct_scene3d", direct([UNKNOWN_ID]));
    expect(out.kind).toBe("known_failure");
    expect((await stageRow(id, "direct_scene3d")).result).toMatchObject({ error: expect.stringMatching(/scene3d_invalid: .*after 3 attempts.*pp_unicorn/) });
    expect(await latestContent(db.pool, id, "scenes")).toBeNull();
    expect((await db.pool.query("select kind from videos where id = $1", [id])).rows[0].kind).toBe("scene3d");
  });

  it("refuses a script that has no story", async () => {
    const id = await scene3dVideo(null);
    expect((await play(id, "direct_scene3d", direct([GOOD]))).kind).toBe("known_failure");
    expect((await stageRow(id, "direct_scene3d")).result).toMatchObject({ error: expect.stringMatching(/no valid 3D story/) });
  });

  it("refuses when no catalogue is wired", async () => {
    const id = await scene3dVideo();
    const out = await play(id, "direct_scene3d", withAttempt({ db: db.pool, root }, directScene3dAttempt(mkDeps({ makeLlm: llmWith([GOOD]), catalog3d: undefined }))));
    expect(out.kind).toBe("known_failure");
  });

  it("the Build step refuses a scene3d video (it has no build step)", async () => {
    const id = await scene3dVideo();
    const out = await play(id, "build", withAttempt({ db: db.pool, root }, buildAttempt(mkDeps({ makeLlm: llmWith([GOOD]) }))));
    expect(out.kind).toBe("known_failure");
  });
});

describe("scene3d: render stage (native only)", () => {
  const ready = async () => ({ ready: true, message: "Ready" });
  const notReady = async () => ({ ready: false, message: "Not ready: sandbox-exec is missing." });

  async function directedAndNarrated(): Promise<string> {
    const id = await scene3dVideo();
    expect((await play(id, "direct_scene3d", direct([GOOD]))).kind).toBe("committed");
    expect((await play(id, "tts", withAttempt({ db: db.pool, root }, ttsAttempt(mkDeps({}))))).kind).toBe("committed");
    return id;
  }
  const renderWith = (id: string, deps: Partial<StageDeps>, cfg = nativeOn) => play(id, "render", withAttempt({ db: db.pool, root }, renderAttempt(mkDeps(deps))), cfg);

  it("renders through the native renderer only, with the scene re-timed to the voice, and promotes render.mp4", async () => {
    const id = await directedAndNarrated();
    const container = capture();
    const native = capture();
    const out = await renderWith(id, { renderer: container, native: { renderer: native, ready } });
    expect(out.kind).toBe("committed");
    expect(container.calls).toHaveLength(0);
    expect(native.calls).toHaveLength(1);
    const a = native.calls[0]!;
    expect(a.scale3d).toBeUndefined();
    expect(a.doc).toBeUndefined();
    expect(a.size).toEqual({ width: 1080, height: 1920 });
    expect(a.outFile).toBe("render.mp4");
    expect(path.basename(a.sceneFile)).toBe("scene3d.json");
    expect(a.scene3d?.shots).toHaveLength(7);
    expect(a.scene3d?.shots.every((s) => s.duration_s >= 2 && s.duration_s <= 12)).toBe(true);
    expect((await stageRow(id, "render")).result).toMatchObject({ rendered: "render.mp4", kind: "scene3d", retimed: true, shots: 7 });
    expect(a.scene3d?.shots.map((s) => s.duration_s)).not.toEqual(Array(7).fill(8));
    expect(existsSync(path.join(root, "videos", id, "render.mp4"))).toBe(true);
  });

  it("the container's own 900 s limit does not apply to the native render", async () => {
    const id = await directedAndNarrated();
    const out = await renderWith(id, { native: { renderer: capture(), ready } }, nativeOn); // render.timeout_s stays 600
    expect(out.kind).toBe("committed");
  });

  it("is refused, naming render.native_3d and the Chrome command, when the setting is off; no renderer is called", async () => {
    const id = await directedAndNarrated();
    const container = capture();
    const native = capture();
    const out = await renderWith(id, { renderer: container, native: { renderer: native, ready } }, config);
    expect(out.kind).toBe("known_failure");
    const error = (await stageRow(id, "render")).result.error as string;
    expect(error).toMatch(/render\.native_3d/);
    expect(error).toMatch(/npx remotion browser ensure/);
    expect(container.calls).toHaveLength(0);
    expect(native.calls).toHaveLength(0);
  });

  it("is refused, with no fallback to the container, when the preflight is not ready", async () => {
    const id = await directedAndNarrated();
    const container = capture();
    const native = capture();
    const out = await renderWith(id, { renderer: container, native: { renderer: native, ready: notReady } });
    expect(out.kind).toBe("known_failure");
    expect((await stageRow(id, "render")).result).toMatchObject({ error: expect.stringMatching(/not ready.*sandbox-exec is missing.*render\.native_3d/) });
    expect(container.calls).toHaveLength(0);
    expect(native.calls).toHaveLength(0);
  });

  it("is refused, with no fallback, when the switch is on but no native renderer is wired", async () => {
    const id = await directedAndNarrated();
    const container = capture();
    const raised = buildEngineConfig(new Map<string, unknown>([["render.native_3d", true], ["render.timeout_s", 900]]));
    const out = await renderWith(id, { renderer: container }, raised);
    expect(out.kind).toBe("known_failure");
    expect(container.calls).toHaveLength(0);
  });

  it("a native render that fails is not retried in the container", async () => {
    const id = await directedAndNarrated();
    const container = capture();
    const failing: Renderer = { render: async () => { throw new KnownFailure("native boom"); } };
    const out = await renderWith(id, { renderer: container, native: { renderer: failing, ready } });
    expect(out.kind).toBe("known_failure");
    expect((await stageRow(id, "render")).result).toMatchObject({ error: expect.stringMatching(/native boom/) });
    expect(container.calls).toHaveLength(0);
  });
});
