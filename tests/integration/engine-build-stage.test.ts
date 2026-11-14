import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildEngineConfig } from "@/server/core/engine-config";
import { canonicalJson, sha256Hex } from "@/server/core/content-hash";
import { uuidv7 } from "@/server/core/ids";
import type { StageHandler } from "@/server/core/stage-handler";
import type { StageOutcome } from "@/server/core/stage-runner";
import { targetFrames } from "@/server/core/tsx-prompt";
import { approveGate, liveGateHash } from "@/server/db/approvals";
import { runStage } from "@/server/db/stage-runner-adapter";
import { insertQueuedStage } from "@/server/db/stages";
import { addContent, createVideoRow, latestContent } from "@/server/db/videos";
import type { EngineDeps, EngineRequest, EngineResult } from "@/server/engine/run";
import { fakeDraft } from "@/server/llm/fake-step";
import { createFakeImage } from "@/server/providers/media/fake";
import { createFakeRenderer } from "@/server/providers/renderer/fake";
import type { TsxRenderer, TsxRenderResult } from "@/server/providers/renderer";
import type { TsxRendererDeps } from "@/server/providers/renderer/tsx-render";
import { createFakeVoice } from "@/server/providers/voice/fake";
import { withAttempt } from "@/worker/stages/attempt";
import type { StageDeps } from "@/worker/stages/deps";
import { codeSceneAttempt } from "@/worker/stages/engine-build";
import { ttsAttempt } from "@/worker/stages/tts";
import { audioSeconds } from "@/worker/stages/voice-audio";
import { GOOD_SCENE } from "../fixtures/tsx-good-scene";
import { withTestDb, type TestDb } from "../support/db";

// OpenMontage parity, Phase D1: with the engine switched on, a tsx video's code-scene step is written by the engine (Claude Code
// with the six engine tools) and then rendered through the same sandboxed renderTsx; with it off, nothing changes. The engine
// and the sandbox are fakes here (the real ones have their own tests and the owner's real run).

let db: TestDb;
let root: string;
const SESSION = { kind: "session", sessionId: "11111111-1111-4111-8111-111111111111" } as const;
const GOOD_MP4 = path.resolve(process.cwd(), "tests/fixtures/video/good.mp4");
const ON = buildEngineConfig(new Map<string, unknown>([["engine.enabled", true]]));
const OFF = buildEngineConfig(new Map());

beforeAll(async () => {
  db = await withTestDb();
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "engine-build-")));
});
afterAll(async () => {
  rmSync(root, { recursive: true, force: true });
  await db?.stop();
});
beforeEach(async () => {
  await db.reset();
  await db.pool.query("insert into budgets (scope, cap_micro_usd) values ('draft_run', 3000000), ('video:tsx', 2000000), ('day', 15000000), ('month', 100000000)");
});

function fakeTsx(): TsxRenderer & { sources: string[] } {
  const sources: string[] = [];
  return {
    sources,
    async renderTsx(ctx, input): Promise<TsxRenderResult> {
      sources.push(input.source);
      const outPath = path.join(ctx.attemptDir, input.outFile);
      copyFileSync(GOOD_MP4, outPath);
      const stills = ["tsx-frame-first.png", "tsx-frame-middle.png", "tsx-frame-last.png"];
      for (const f of stills) writeFileSync(path.join(ctx.attemptDir, f), "png");
      return { ok: true, outPath, image: "fake-image", stills };
    },
  };
}
function mkDeps(over: Partial<StageDeps>): StageDeps {
  const voice = createFakeVoice();
  return { db: db.pool, root, voiceFor: async (a: { budgetScopes: string[] }) => ({ provider: voice.forScopes(a.budgetScopes), providerId: "fake", voice: "fake" }), image: createFakeImage(), renderer: createFakeRenderer(), ...over } as never;
}
const noProvider = { call: async () => Promise.reject(new Error("no provider in handler mode")) };
async function play(videoId: string, name: string, handler: StageHandler, config = ON): Promise<StageOutcome> {
  const inputHash = `h-${name}-${uuidv7()}`;
  const stageRunId = await insertQueuedStage(db.pool, { videoId, name, inputHash });
  return runStage(db.pool, { provider: noProvider, ttlMs: 60_000, workerId: "w1", handler, config }, { stageRunId, inputHash });
}
async function tsxVideoWithNarration(): Promise<{ id: string; frames: number }> {
  const v = await createVideoRow(db.pool, { format: "short", kind: "tsx", language: "en", topic: "Why we need Docker" });
  const d = fakeDraft("en") as { title: string; narration: string };
  await addContent(db.pool, v.id, "script", { body: { title: d.title, narration: d.narration }, sha256: sha256Hex(canonicalJson(d)) });
  const beats = { beats: [{ id: "b1", text: "x", visual: "a laptop" }, { id: "b2", text: "y", visual: "a container" }] };
  await addContent(db.pool, v.id, "beats", { body: beats, sha256: sha256Hex(canonicalJson(beats)) });
  const live = await liveGateHash(db.pool, v.id, "script");
  const ok = await approveGate(db.pool, { videoId: v.id, gate: "script", seenHash: live!.hash, actor: SESSION });
  if (!ok.ok) throw new Error(ok.reason);
  const tts = await play(v.id, "tts", withAttempt({ db: db.pool, root }, ttsAttempt(mkDeps({}))), OFF);
  if (tts.kind !== "committed") throw new Error(`tts ended ${tts.kind}`);
  const narration = (await latestContent(db.pool, v.id, "narration"))!.body as { file: string };
  const seconds = await audioSeconds(undefined, {} as never, path.join(root, "videos", v.id, narration.file));
  return { id: v.id, frames: targetFrames(seconds) };
}

/** A scripted engine: writes `source` (or nothing) into its own work folder, or reports the usage limit. Records the requests. */
function fakeEngine(o: { source?: string; limit?: Date }) {
  const calls: Array<{ req: EngineRequest; toolNames: string[] }> = [];
  const run = async (deps: EngineDeps, req: EngineRequest): Promise<EngineResult> => {
    const workDir = mkdtempSync(path.join(root, "work-"));
    calls.push({ req, toolNames: deps.tools ? deps.tools({ dir: workDir, workDir, snapshot: async () => ({}) as never }).map((t) => t.name) : [] });
    if (o.limit) return { ok: false, limit: true, resumeAt: o.limit };
    if (o.source !== undefined) {
      mkdirSync(path.join(workDir, "scene"));
      writeFileSync(path.join(workDir, "scene", "video.tsx"), o.source);
    }
    return { ok: true, text: "b1: a laptop\nb2: a container", usage: { inputTokens: 1, outputTokens: 1, costUsdEquiv: 0 } as never, turns: 12, workDir };
  };
  return { run, calls };
}
const render = { kitDir: "/k", runChild: async () => ({ code: 0, signal: null, truncated: false, timedOut: false, aborted: false }), probe: async () => ({}) } as unknown as TsxRendererDeps;
const engineDeps = (run: ReturnType<typeof fakeEngine>["run"]) => ({ root: path.join(root, "engine"), render, runEngine: run });
/** The plain sentence a failed step stored (stage_runs.result). */
const reason = async (out: StageOutcome) => JSON.stringify((await db.pool.query("select result from stage_runs where id = $1", [(out as { claim: { stageRunId: string } }).claim.stageRunId])).rows[0]?.result);
const withFrames = (n: number) => GOOD_SCENE.replace("durationInFrames: 270", `durationInFrames: ${n}`);

describe("engine code-scene step", () => {
  it("engine_writes_a_scene_and_the_step_renders_it", async () => {
    const { id, frames } = await tsxVideoWithNarration();
    const tsx = fakeTsx();
    const eng = fakeEngine({ source: withFrames(frames) });
    const out = await play(id, "tsx_author", withAttempt({ db: db.pool, root }, codeSceneAttempt(mkDeps({ tsx }), engineDeps(eng.run))));
    expect(out.kind).toBe("committed");
    expect(eng.calls).toHaveLength(1);
    expect(eng.calls[0]!.req.kind).toBe("build");
    expect(Object.keys(eng.calls[0]!.req.inputs ?? {}).sort()).toEqual(["script.json", "words.json"]);
    expect(eng.calls[0]!.req.prompt).toContain("draw-objects");
    expect(eng.calls[0]!.toolNames).toEqual(["check_code", "preview_frames", "check_frames", "check_scenes", "preview_scenes", "list_assets", "fetch_asset"]);
    expect(tsx.sources).toEqual([withFrames(frames)]); // the engine's file, rendered once by the sandboxed renderer
    const saved = (await latestContent(db.pool, id, "tsx"))!.body as { source: string; durationInFrames: number; engine: { turns: number } };
    expect(saved.source).toBe(withFrames(frames));
    expect(saved.durationInFrames).toBe(frames);
    expect(saved.engine.turns).toBe(12);
  });

  it("no_or_bad_scene_fails_with_one_sentence_and_renders_nothing", async () => {
    const { id, frames } = await tsxVideoWithNarration();
    for (const [source, msg] of [
      [undefined, /did not write scene\/video\.tsx/],
      [withFrames(frames + 30), new RegExp(`must be ${frames}`)],
      ["export default function S() { return fetch('https://x.test'); }\nexport const meta = { durationInFrames: 1 };", /safety check/],
    ] as const) {
      const tsx = fakeTsx();
      const out = await play(id, "tsx_author", withAttempt({ db: db.pool, root }, codeSceneAttempt(mkDeps({ tsx }), engineDeps(fakeEngine({ source }).run))));
      expect(out.kind, String(msg)).toBe("known_failure");
      expect(await reason(out)).toMatch(msg);
      expect(tsx.sources).toEqual([]);
    }
  });

  it("usage_limit_pauses_the_step_with_a_resume_time", async () => {
    const { id } = await tsxVideoWithNarration();
    const at = new Date(Date.now() + 3_600_000);
    const out = await play(id, "tsx_author", withAttempt({ db: db.pool, root }, codeSceneAttempt(mkDeps({ tsx: fakeTsx() }), engineDeps(fakeEngine({ limit: at }).run))));
    expect(out.kind).toBe("known_failure");
    expect(await reason(out)).toMatch(/Claude limit reached\. This step resumes about .* IST by itself\./);
  });

  it("engine_off_keeps_the_paid_model_step", async () => {
    const { id } = await tsxVideoWithNarration();
    const eng = fakeEngine({ source: "x" });
    const out = await play(id, "tsx_author", withAttempt({ db: db.pool, root }, codeSceneAttempt(mkDeps({ tsx: fakeTsx() }), engineDeps(eng.run))), OFF);
    expect(eng.calls).toHaveLength(0);
    expect(await reason(out)).toMatch(/No scene model is wired/); // the paid-model step ran (and found no model in this test)
  });

  it("narration_over_90_s_is_refused_before_the_engine_runs", async () => {
    const { id } = await tsxVideoWithNarration();
    const eng = fakeEngine({ source: "x" });
    const out = await play(id, "tsx_author", withAttempt({ db: db.pool, root }, codeSceneAttempt(mkDeps({ tsx: fakeTsx(), mix: { runChild: async () => ({ code: 0 }), audioRoot: root } as never }), { ...engineDeps(eng.run), narrationSeconds: async () => 95 })));
    expect(eng.calls).toHaveLength(0);
    expect(await reason(out)).toMatch(/over the 90 s limit/);
  });
});
