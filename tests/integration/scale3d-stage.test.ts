import type { LanguageModel } from "ai";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { canonicalJson, sha256Hex } from "@/server/core/content-hash";
import { buildEngineConfig } from "@/server/core/engine-config";
import { uuidv7 } from "@/server/core/ids";
import { wordRange } from "@/server/core/lang";
import type { ModelRow } from "@/server/core/llm-catalog";
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
import { KnownFailure } from "@/server/core/paid-call";
import { createFakeVoice } from "@/server/providers/voice/fake";
import { validateScale3d } from "@/shared/scale3d";
import { withAttempt } from "@/worker/stages/attempt";
import { buildAttempt } from "@/worker/stages/build";
import type { StageDeps } from "@/worker/stages/deps";
import { renderAttempt, SCALE3D_MIN_RENDER_TIMEOUT_S } from "@/worker/stages/render";
import { ttsAttempt } from "@/worker/stages/tts";
import { withTestDb, type TestDb } from "../support/db";

// The scale3d kind through Build and Render on a fake model and a fake renderer (no real render, no Docker).
let db: TestDb;
let root: string;
const config = buildEngineConfig(new Map());
const SESSION = { kind: "session", sessionId: "11111111-1111-4111-8111-111111111111" } as const;
const GOOD_MP4 = path.resolve(process.cwd(), "tests/fixtures/video/good.mp4");

beforeAll(async () => {
  db = await withTestDb();
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "scale3d-stage-")));
});
afterAll(async () => {
  rmSync(root, { recursive: true, force: true });
  await db?.stop();
});
beforeEach(async () => {
  await db.reset();
  await db.pool.query("insert into budgets (scope, cap_micro_usd) values ('draft_run', 3000000), ('video:scene_kit', 2000000), ('video:scale3d', 2000000), ('day', 15000000), ('month', 100000000)");
});

const ROW: ModelRow = { id: "00000000-0000-4000-8000-0000000000bb", provider: "anthropic", modelId: "m", label: "Fake", baseUrl: null, prices: { inputPerMTokMicro: 1_000_000, outputPerMTokMicro: 1_000_000 }, isFree: false, capabilities: { structuredOutput: true, toolUse: true, vision: false, nativeWebSearch: false, contextWindow: 128000 }, enabled: true, endpointKind: "hosted" };
const llmWith = (texts: string[]) => {
  const step = fakeModelStep({ script: texts.map((text) => ({ text, toolCalls: [], usage: { inputTokens: 100, outputTokens: 50 } })) });
  return (scopes: string[]) => createLlmClient({ db: db.pool, catalog: { route: async () => ROW, localServices: async () => [] }, getKey: async () => null, buildModel: () => ({}) as LanguageModel, budgetScopes: () => scopes, makeStep: () => step });
};

function mkDeps(over: Partial<StageDeps>): StageDeps {
  const voice = createFakeVoice();
  return { db: db.pool, root, voiceFor: async (a: { budgetScopes: string[] }) => ({ provider: voice.forScopes(a.budgetScopes), providerId: "fake", voice: "fake" }), image: createFakeImage(), renderer: createFakeRenderer(), ...over } as never;
}

const noProvider = { call: async () => Promise.reject(new Error("no provider in handler mode")) };
async function play(videoId: string, name: string, handler: StageHandler, cfg = config): Promise<StageOutcome> {
  const inputHash = `h-${name}-${uuidv7()}`;
  const stageRunId = await insertQueuedStage(db.pool, { videoId, name, inputHash });
  return runStage(db.pool, { provider: noProvider, ttlMs: 60_000, workerId: "w1", handler, config: cfg }, { stageRunId, inputHash });
}

const SCALE = [
  { label: "Person", kind: "person", height_m: 1.8, method: "an average adult" },
  { label: "Tower crane", kind: "tower_crane", height_m: 80, source_url: "https://a.test/crane", quote: "a tower crane reaches about 80 m" },
  { label: "Burj Khalifa", kind: "skyscraper", height_m: 828, source_url: "https://a.test/burj", quote: "the Burj Khalifa is 828 m tall" },
];
const NARRATION = Array.from({ length: Math.round((wordRange("en").min + wordRange("en").max) / 2) }, (_, i) => `word${i}`).join(" ");
const beat = (focus: string) => ({ focus, label: "BIG", caption: "one two three four five six seven eight", duration_s: 4 });
const GOOD = JSON.stringify({ version: 1, objects: [], beats: [beat("person"), beat("tower_crane"), beat("burj_khalifa"), beat("person")] });

/** A scale3d video with an approved script (narration + scale list). */
async function scale3dVideo(): Promise<string> {
  const v = await createVideoRow(db.pool, { format: "short", kind: "scale3d", language: "en", topic: "How tall is a tower crane next to a skyscraper?" });
  const script = { title: "Tall", narration: NARRATION, scale: SCALE };
  await addContent(db.pool, v.id, "script", { body: script, sha256: sha256Hex(canonicalJson(script)) });
  const beats = { beats: [{ id: "hook", text: "x" }, { id: "loop", text: "y" }] };
  await addContent(db.pool, v.id, "beats", { body: beats, sha256: sha256Hex(canonicalJson(beats)) });
  const live = await liveGateHash(db.pool, v.id, "script");
  const ok = await approveGate(db.pool, { videoId: v.id, gate: "script", seenHash: live!.hash, actor: SESSION });
  if (!ok.ok) throw new Error(ok.reason);
  return v.id;
}

const build = (texts: string[]) => withAttempt({ db: db.pool, root }, buildAttempt(mkDeps({ makeLlm: llmWith(texts) })));
const stageRow = async (id: string, name: string) => (await db.pool.query("select status, result from stage_runs where video_id = $1 and name = $2 order by created_at desc limit 1", [id, name])).rows[0] as { status: string; result: Record<string, unknown> };

/** A renderer that records its call and copies a real mp4 like the container renderer's output. */
function capture(): Renderer & { calls: RenderArgs[] } {
  const calls: RenderArgs[] = [];
  const fake = createFakeRenderer({ fixture: GOOD_MP4 });
  return { calls, render: (ctx, a) => (calls.push(a), fake.render(ctx, a)) };
}

describe("scale3d: draft evidence", () => {
  it("each height becomes an evidence claim saved with the draft, and the scale list is kept in the script", async () => {
    const v = await createVideoRow(db.pool, { format: "short", kind: "scale3d", language: "en", topic: "t" });
    const stageId = await insertQueuedStage(db.pool, { videoId: v.id, name: "draft", inputHash: "h" });
    const claim = (await claimStage(db.pool, { id: stageId, inputHash: "h", workerId: "w1", ttlMs: 600_000 }))!;
    const checked = validateScript({ title: "Tall", narration: NARRATION, beats: [{ id: "hook" }, { id: "loop" }], evidence: [], scale: SCALE }, "en", "short", { kind: "scale3d" });
    if (!checked.ok) throw new Error(checked.problems.join());
    await saveDraftContent(db.pool, v.id, claim, checked.script);
    const evidence = (await latestContent(db.pool, v.id, "evidence"))!.body as { claims: Array<{ text: string; kind: string }> };
    expect(evidence.claims.map((c) => [c.text, c.kind])).toEqual([["Person is about 1.8 m tall", "computed"], ["Tower crane is about 80 m tall", "sourced"], ["Burj Khalifa is about 828 m tall", "sourced"]]);
    expect(((await latestContent(db.pool, v.id, "script"))!.body as { scale: unknown[] }).scale).toHaveLength(3);
  });
});

describe("scale3d: build stage", () => {
  it("retries a bad answer with the checker's sentences, then saves the checked description as scenes content", async () => {
    const id = await scale3dVideo();
    const out = await play(id, "build", build(["not json", GOOD]));
    expect(out.kind).toBe("committed");
    const saved = (await latestContent(db.pool, id, "scenes"))!.body as { kind: string; scene: unknown };
    expect(saved.kind).toBe("scale3d");
    const v = validateScale3d(saved.scene);
    expect(v.ok).toBe(true);
    expect(v.ok && v.scene.objects.map((o) => o.height_m)).toEqual([1.8, 80, 828]);
    expect(v.ok && v.totalS).toBeGreaterThanOrEqual(30);
    expect(existsSync(path.join(root, "videos", id, "scale3d.json"))).toBe(true);
    expect((await stageRow(id, "build")).result).toMatchObject({ kind: "scale3d", attempts: 2, beats: 4, objects: 3 });
    expect(await latestContent(db.pool, id, "cost_plan")).toBeNull(); // nothing to buy
  });

  it("fails with a plain message after three bad answers and keeps the kind", async () => {
    const id = await scale3dVideo();
    const out = await play(id, "build", build(["garbage"]));
    expect(out.kind).toBe("known_failure");
    expect((await stageRow(id, "build")).result).toMatchObject({ error: expect.stringMatching(/scale3d_invalid: .*after 3 attempts/) });
    expect(await latestContent(db.pool, id, "scenes")).toBeNull();
    expect((await db.pool.query("select kind from videos where id = $1", [id])).rows[0].kind).toBe("scale3d");
  });

  it("refuses a script that has no scale list", async () => {
    const v = await createVideoRow(db.pool, { format: "short", kind: "scale3d", language: "en", topic: "t" });
    const script = { title: "T", narration: NARRATION };
    await addContent(db.pool, v.id, "script", { body: script, sha256: sha256Hex(canonicalJson(script)) });
    const beats = { beats: [{ id: "hook", text: "x" }] };
    await addContent(db.pool, v.id, "beats", { body: beats, sha256: sha256Hex(canonicalJson(beats)) });
    const live = await liveGateHash(db.pool, v.id, "script");
    await approveGate(db.pool, { videoId: v.id, gate: "script", seenHash: live!.hash, actor: SESSION });
    expect((await play(v.id, "build", build([GOOD]))).kind).toBe("known_failure");
    expect((await stageRow(v.id, "build")).result).toMatchObject({ error: expect.stringMatching(/no valid 3D scale list/) });
  });
});

describe("scale3d: render stage", () => {
  const raised = buildEngineConfig(new Map([["render.timeout_s", SCALE3D_MIN_RENDER_TIMEOUT_S]]));

  async function builtAndNarrated(): Promise<string> {
    const id = await scale3dVideo();
    expect((await play(id, "build", build([GOOD]))).kind).toBe("committed");
    expect((await play(id, "tts", withAttempt({ db: db.pool, root }, ttsAttempt(mkDeps({}))))).kind).toBe("committed");
    return id;
  }

  it("renders the 3D description, re-timed to the voice, at 1080x1920 through the renderer, and promotes render.mp4", async () => {
    const id = await builtAndNarrated();
    const renderer = capture();
    const out = await play(id, "render", withAttempt({ db: db.pool, root }, renderAttempt(mkDeps({ renderer }))), raised);
    expect(out.kind).toBe("committed");
    expect(renderer.calls).toHaveLength(1);
    const a = renderer.calls[0]!;
    expect(a.doc).toBeUndefined();
    expect(a.size).toEqual({ width: 1080, height: 1920 });
    expect(a.outFile).toBe("render.mp4");
    expect(path.basename(a.sceneFile)).toBe("scale3d.json");
    expect(Array.isArray(a.captions) && a.captions.length > 0).toBe(true);
    expect(a.scale3d?.beats).toHaveLength(4);
    const built = JSON.parse(readFileSync(path.join(root, "videos", id, "scale3d.json"), "utf8")) as { beats: Array<{ duration_s: number }> };
    expect((await stageRow(id, "render")).result).toMatchObject({ rendered: "render.mp4", kind: "scale3d", retimed: true });
    expect(a.scale3d?.beats.map((b) => b.duration_s)).not.toEqual(built.beats.map((b) => b.duration_s));
    expect(existsSync(path.join(root, "videos", id, "render.mp4"))).toBe(true);
  });

  it("is refused up front, naming the setting, when the render time limit is under the 3D minimum", async () => {
    const id = await builtAndNarrated();
    const renderer = capture();
    const out = await play(id, "render", withAttempt({ db: db.pool, root }, renderAttempt(mkDeps({ renderer }))), config);
    expect(out.kind).toBe("known_failure");
    expect((await stageRow(id, "render")).result).toMatchObject({ error: expect.stringMatching(/render\.timeout_s.*900/) });
    expect(renderer.calls).toHaveLength(0);
  });

  describe("native Mac renderer choice (Phase 5d)", () => {
    const nativeOn = buildEngineConfig(new Map<string, unknown>([["render.native_3d", true]])); // render.timeout_s stays 600
    const ready = async () => ({ ready: true, message: "Ready" });
    const notReady = async () => ({ ready: false, message: "Not ready: sandbox-exec is missing." });

    it("uses the native renderer when the switch is on and the preflight is ready, even with the container limit under 900", async () => {
      const id = await builtAndNarrated();
      const container = capture();
      const native = capture();
      const out = await play(id, "render", withAttempt({ db: db.pool, root }, renderAttempt(mkDeps({ renderer: container, native: { renderer: native, ready } }))), nativeOn);
      expect(out.kind).toBe("committed");
      expect(native.calls).toHaveLength(1);
      expect(native.calls[0]!.scale3d?.beats).toHaveLength(4);
      expect(container.calls).toHaveLength(0);
    });

    it("uses the container, as before, when the switch is off, even if a native renderer is wired and ready", async () => {
      const id = await builtAndNarrated();
      const container = capture();
      const native = capture();
      const out = await play(id, "render", withAttempt({ db: db.pool, root }, renderAttempt(mkDeps({ renderer: container, native: { renderer: native, ready } }))), raised);
      expect(out.kind).toBe("committed");
      expect(container.calls).toHaveLength(1);
      expect(native.calls).toHaveLength(0);
    });

    it("the 900 s guard still applies to the container when the switch is off", async () => {
      const id = await builtAndNarrated();
      const container = capture();
      const native = capture();
      const out = await play(id, "render", withAttempt({ db: db.pool, root }, renderAttempt(mkDeps({ renderer: container, native: { renderer: native, ready } }))), config);
      expect(out.kind).toBe("known_failure");
      expect(container.calls).toHaveLength(0);
      expect(native.calls).toHaveLength(0);
    });

    it("falls back to the container when the preflight is not ready, and the guard applies to it", async () => {
      const id = await builtAndNarrated();
      const container = capture();
      const native = capture();
      const refused = await play(id, "render", withAttempt({ db: db.pool, root }, renderAttempt(mkDeps({ renderer: container, native: { renderer: native, ready: notReady } }))), nativeOn);
      expect(refused.kind).toBe("known_failure"); // render.timeout_s is 600: the container guard, not a native render
      expect(native.calls).toHaveLength(0);
      const both = buildEngineConfig(new Map<string, unknown>([["render.native_3d", true], ["render.timeout_s", SCALE3D_MIN_RENDER_TIMEOUT_S]]));
      const id2 = await builtAndNarrated();
      const out = await play(id2, "render", withAttempt({ db: db.pool, root }, renderAttempt(mkDeps({ renderer: container, native: { renderer: native, ready: notReady } }))), both);
      expect(out.kind).toBe("committed");
      expect(container.calls).toHaveLength(1);
      expect(native.calls).toHaveLength(0);
    });

    it("falls back to the container when the switch is on but no native renderer is wired", async () => {
      const id = await builtAndNarrated();
      const container = capture();
      const both = buildEngineConfig(new Map<string, unknown>([["render.native_3d", true], ["render.timeout_s", SCALE3D_MIN_RENDER_TIMEOUT_S]]));
      const out = await play(id, "render", withAttempt({ db: db.pool, root }, renderAttempt(mkDeps({ renderer: container }))), both);
      expect(out.kind).toBe("committed");
      expect(container.calls).toHaveLength(1);
    });

    it("a native render that fails is not retried in the container", async () => {
      const id = await builtAndNarrated();
      const container = capture();
      const failing: Renderer = { render: async () => { throw new KnownFailure("native boom"); } };
      const out = await play(id, "render", withAttempt({ db: db.pool, root }, renderAttempt(mkDeps({ renderer: container, native: { renderer: failing, ready } }))), nativeOn);
      expect(out.kind).toBe("known_failure");
      expect((await stageRow(id, "render")).result).toMatchObject({ error: expect.stringMatching(/native boom/) });
      expect(container.calls).toHaveLength(0);
    });
  });
});
