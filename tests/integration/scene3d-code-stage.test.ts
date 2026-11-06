import type { LanguageModel } from "ai";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { canonicalJson, sha256Hex } from "@/server/core/content-hash";
import { buildEngineConfig } from "@/server/core/engine-config";
import { uuidv7 } from "@/server/core/ids";
import type { ModelRow } from "@/server/core/llm-catalog";
import { readPreviews } from "@/server/core/scene3d-stills";
import { readSceneCodeBody, sceneCodeSha } from "@/server/core/scene3d-code-body";
import type { StageHandler } from "@/server/core/stage-handler";
import type { StageOutcome } from "@/server/core/stage-runner";
import { approveGate, liveGateHash } from "@/server/db/approvals";
import { runStage } from "@/server/db/stage-runner-adapter";
import { insertQueuedStage } from "@/server/db/stages";
import { addContent, createVideoRow, latestContent } from "@/server/db/videos";
import { createLlmClient } from "@/server/llm/client";
import { fakeModelStep } from "@/server/llm/fake-step";
import { createFakeImage } from "@/server/providers/media/fake";
import { createFakeRenderer } from "@/server/providers/renderer/fake";
import type { RenderArgs, Renderer, Scene3dStillsArgs, Scene3dStillsRenderer } from "@/server/providers/renderer";
import { createFakeVoice } from "@/server/providers/voice/fake";
import { withAttempt } from "@/worker/stages/attempt";
import type { StageDeps } from "@/worker/stages/deps";
import { renderAttempt } from "@/worker/stages/render";
import { scene3dAuthorAttempt } from "@/worker/stages/scene3d-author";
import { scene3dStillsAttempt } from "@/worker/stages/scene3d-stills";
import { ttsAttempt } from "@/worker/stages/tts";
import { fakeCatalog } from "../support/catalog3d";
import { withTestDb, type TestDb } from "../support/db";

// The scene3d_code kind on a FAKE model and fake renderers: author (retries, failure, storage), preview pictures, the Look gate, Render
// refusals (no approval, a changed scene.tsx, a damaged stored body). No real model, no render, no Docker.
let db: TestDb;
let root: string;
const config = buildEngineConfig(new Map());
const nativeOn = buildEngineConfig(new Map<string, unknown>([["render.native_3d", true]]));
const SESSION = { kind: "session", sessionId: "11111111-1111-4111-8111-111111111111" } as const;
const GOOD_MP4 = path.resolve(process.cwd(), "tests/fixtures/video/good.mp4");

beforeAll(async () => {
  db = await withTestDb();
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "scene3d-code-stage-")));
});
afterAll(async () => {
  rmSync(root, { recursive: true, force: true });
  await db?.stop();
});
beforeEach(async () => {
  await db.reset();
  await db.pool.query("insert into budgets (scope, cap_micro_usd) values ('draft_run', 3000000), ('video:scene_kit', 2000000), ('video:scene3d_code', 2000000), ('day', 15000000), ('month', 100000000)");
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
  hook: "A tall skyline rises over the sea", setup: "A cargo ship floats beside a rock wall", dig: "Workers stand on the sand", load: "A crane lifts rocks onto a truck",
  pour: "Sand pours into the water", reveal: "A palm tree stands on the new land", loop: "The camera rises back to the skyline",
};
const line = (id: string) => Array.from({ length: 14 }, (_, i) => `${id}${i}`).join(" ");
const STORY = IDS.map((id) => ({ id, visual: VISUALS[id]!, line: line(id) }));
const NARRATION = STORY.map((b) => b.line).join(" ");

/** A scene that passes the static check AND the real type-check, and names the catalogue model pp_ship. */
const GOOD = "```tsx\n" + `import { World, CameraRig, Finish, useModels } from "s3k";
import type { SceneProps } from "s3k";

const SHIP = "pp_ship";

export default function Scene({ resolver }: SceneProps) {
  const models = useModels([SHIP], resolver);
  if (!models) return null;
  return (
    <>
      <World focus={{ min: [-10, 0, -10], max: [10, 10, 10] }} ground={{ y: 0 }} sea={false} />
      <primitive object={models.get(SHIP, { size: 12 })} />
      <CameraRig shots={[{ t: 0, at: [30, 12, 30], look: [0, 3, 0] }, { t: 10, at: [-30, 12, 30], look: [0, 3, 0] }]} floor={1} />
      <Finish />
    </>
  );
}
` + "```";
const BAD_FETCH = "```tsx\nexport default function Scene() { fetch('http://127.0.0.1:3000/x'); return null; }\n```";

/** A scene3d_code video with an approved script (narration + story). */
async function codeVideo(kind: "scene3d_code" | "scene3d" = "scene3d_code"): Promise<string> {
  const v = await createVideoRow(db.pool, { format: "short", kind, language: "en", topic: "How Dubai made land from the sea" });
  const script = { title: "Land from the sea", narration: NARRATION, story: STORY };
  await addContent(db.pool, v.id, "script", { body: script, sha256: sha256Hex(canonicalJson(script)) });
  const beats = { beats: IDS.map((id) => ({ id, text: line(id) })) };
  await addContent(db.pool, v.id, "beats", { body: beats, sha256: sha256Hex(canonicalJson(beats)) });
  const live = await liveGateHash(db.pool, v.id, "script");
  const ok = await approveGate(db.pool, { videoId: v.id, gate: "script", seenHash: live!.hash, actor: SESSION });
  if (!ok.ok) throw new Error(ok.reason);
  return v.id;
}
const author = (texts: string[], over: Partial<StageDeps> = {}) => withAttempt({ db: db.pool, root }, scene3dAuthorAttempt(mkDeps({ makeLlm: llmWith(texts), ...over })));
const stageRow = async (id: string, name: string) => (await db.pool.query("select status, result from stage_runs where video_id = $1 and name = $2 order by created_at desc limit 1", [id, name])).rows[0] as { status: string; result: Record<string, unknown> };
const tts = (id: string) => play(id, "tts", withAttempt({ db: db.pool, root }, ttsAttempt(mkDeps({}))));

function capture(): Renderer & { calls: RenderArgs[] } {
  const calls: RenderArgs[] = [];
  const fake = createFakeRenderer({ fixture: GOOD_MP4 });
  return { calls, render: (ctx, a) => (calls.push(a), fake.render(ctx, a)) };
}
const png = (n: number) => {
  const b = Buffer.alloc(40, n);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write("IHDR", 12, "ascii");
  b.writeUInt32BE(540, 16);
  b.writeUInt32BE(960, 20);
  return b;
};
function fakeStills(): Scene3dStillsRenderer & { calls: Scene3dStillsArgs[] } {
  const calls: Scene3dStillsArgs[] = [];
  return {
    calls,
    stills: async (ctx, a) => {
      calls.push(a);
      mkdirSync(path.join(ctx.attemptDir, "stills"), { recursive: true });
      const files = a.frames.map((_, i) => `stills/${String(i + 1).padStart(2, "0")}.png`);
      files.forEach((f, i) => writeFileSync(path.join(ctx.attemptDir, f), png(i + 1)));
      return { files, image: "fake" };
    },
  };
}
const ready = async () => ({ ready: true, message: "Ready" });
const drawPreviews = (id: string, stills = fakeStills()) => play(id, "scene3d_stills", withAttempt({ db: db.pool, root }, scene3dStillsAttempt(mkDeps({ native: { renderer: capture(), stills, ready } }))), nativeOn);
async function approveLook(id: string): Promise<void> {
  const live = await liveGateHash(db.pool, id, "look");
  const r = await approveGate(db.pool, { videoId: id, gate: "look", seenHash: live!.hash, actor: SESSION });
  if (!r.ok) throw new Error(r.reason);
}
const renderWith = (id: string, deps: Partial<StageDeps>, cfg = nativeOn) => play(id, "render", withAttempt({ db: db.pool, root }, renderAttempt(mkDeps(deps))), cfg);

/** Authored and narrated: the state the preview pictures start from. */
async function authored(): Promise<string> {
  const id = await codeVideo();
  expect((await tts(id)).kind).toBe("committed");
  expect((await play(id, "scene3d_author", author([GOOD]))).kind).toBe("committed");
  return id;
}

describe("scene3d_code: author stage", () => {
  it("retries a rejected scene with the checker's sentences, then stores the source as scenes content plus scene.tsx", async () => {
    const id = await codeVideo();
    expect((await tts(id)).kind).toBe("committed");
    const out = await play(id, "scene3d_author", author([BAD_FETCH, GOOD]));
    expect(out.kind).toBe("committed");
    const body = readSceneCodeBody((await latestContent(db.pool, id, "scenes"))!.body)!;
    expect(body.kind).toBe("scene3d_code");
    expect(body.attempts).toBe(2);
    expect(body.models).toEqual(["pp_ship"]);
    expect(body.props.beats.map((b) => b.id)).toEqual(IDS);
    expect(body.props.durationS).toBeGreaterThan(0);
    expect(readFileSync(path.join(root, "videos", id, "scene.tsx"), "utf8")).toBe(body.source);
    expect((await stageRow(id, "scene3d_author")).result).toMatchObject({ kind: "scene3d_code", attempts: 2, models: 1 });
    expect(await latestContent(db.pool, id, "cost_plan")).toBeNull();
  }, 120_000);

  it("fails after 4 rejected attempts with the key sentence first and saves nothing", async () => {
    const id = await codeVideo();
    expect((await tts(id)).kind).toBe("committed");
    const out = await play(id, "scene3d_author", author([BAD_FETCH]));
    expect(out.kind).toBe("known_failure");
    const error = (await stageRow(id, "scene3d_author")).result.error as string;
    expect(error).toMatch(/^scene3d_author_invalid: line 1: global: "fetch" is not available/);
    expect(error.slice(0, 120)).toContain("fetch");
    expect(await latestContent(db.pool, id, "scenes")).toBeNull();
    expect(existsSync(path.join(root, "videos", id, "scene.tsx"))).toBe(false);
    expect((await db.pool.query("select kind from videos where id = $1", [id])).rows[0].kind).toBe("scene3d_code"); // no fallback to another kind
  }, 120_000);

  it("a type error (not caught by the static check) is fed back too", async () => {
    const id = await codeVideo();
    expect((await tts(id)).kind).toBe("committed");
    const typed = "```tsx\nimport { World } from 's3k';\nimport type { SceneProps } from 's3k';\nexport default function Scene(p: SceneProps) { const n: string = p.durationS; return <World focus={{ min: [0, 0, 0], max: [1, 1, 1] }}>{n}</World>; }\n```";
    expect((await play(id, "scene3d_author", author([typed, GOOD]))).kind).toBe("committed");
    expect((await stageRow(id, "scene3d_author")).result).toMatchObject({ attempts: 2 });
  }, 120_000);

  it("refuses a video of another kind, and a worker with no catalogue or no model", async () => {
    const other = await codeVideo("scene3d");
    expect((await play(other, "scene3d_author", author([GOOD]))).kind).toBe("known_failure");
    const id = await codeVideo();
    expect((await play(id, "scene3d_author", author([GOOD], { catalog3d: undefined }))).kind).toBe("known_failure");
    expect((await play(id, "scene3d_author", withAttempt({ db: db.pool, root }, scene3dAuthorAttempt(mkDeps({ makeLlm: undefined }))))).kind).toBe("known_failure");
  }, 120_000);
});

describe("scene3d_code: preview pictures, look gate and Render", () => {
  it("draws the pictures from the authored scene, fingerprints source+props, and Render is refused until the look is approved", async () => {
    const id = await authored();
    const stills = fakeStills();
    expect((await drawPreviews(id, stills)).kind).toBe("committed");
    const call = stills.calls[0]!;
    expect(call.scene3d).toBeUndefined();
    expect(call.scene3dCode?.source).toContain("useModels");
    const body = readSceneCodeBody((await latestContent(db.pool, id, "scenes"))!.body)!;
    const p = readPreviews((await latestContent(db.pool, id, "previews"))!.body)!;
    expect(p.scene_sha256).toBe(sceneCodeSha(body.source, body.props));
    expect(call.scene3dCode?.expectedSha256).toBe(p.scene_sha256);
    expect(p.shots[0]!.id).toBe("hook");
    expect(call.frames.length).toBeGreaterThanOrEqual(6);

    const native = capture();
    const refused = await renderWith(id, { native: { renderer: native, ready } });
    expect(refused.kind).toBe("known_failure");
    expect((await stageRow(id, "render")).result).toMatchObject({ error: expect.stringMatching(/Approve the look/) });
    expect(native.calls).toHaveLength(0);
  }, 120_000);

  it("renders through the native renderer with the approved source, props and fingerprint, never the container", async () => {
    const id = await authored();
    expect((await drawPreviews(id)).kind).toBe("committed");
    await approveLook(id);
    const container = capture();
    const native = capture();
    const out = await renderWith(id, { renderer: container, native: { renderer: native, ready } });
    expect(out.kind).toBe("committed");
    expect(container.calls).toHaveLength(0);
    expect(native.calls).toHaveLength(1);
    const a = native.calls[0]!;
    expect(a.scene3d).toBeUndefined();
    expect(path.basename(a.sceneFile)).toBe("scene.tsx");
    const body = readSceneCodeBody((await latestContent(db.pool, id, "scenes"))!.body)!;
    expect(a.scene3dCode).toEqual({ source: body.source, props: body.props, expectedSha256: sceneCodeSha(body.source, body.props) });
    expect((await stageRow(id, "render")).result).toMatchObject({ rendered: "render.mp4", kind: "scene3d_code" });
    expect(existsSync(path.join(root, "videos", id, "render.mp4"))).toBe(true);
  }, 120_000);

  it("the host REFUSES a scene.tsx that was changed on disk after the checks; no renderer is called", async () => {
    const id = await authored();
    expect((await drawPreviews(id)).kind).toBe("committed");
    await approveLook(id);
    appendFileSync(path.join(root, "videos", id, "scene.tsx"), "\nfetch('http://127.0.0.1:3000/steal');\n");
    const native = capture();
    expect((await renderWith(id, { native: { renderer: native, ready } })).kind).toBe("known_failure");
    expect((await stageRow(id, "render")).result).toMatchObject({ error: expect.stringMatching(/not the scene that was checked and saved/) });
    expect(native.calls).toHaveLength(0);
    // the same file also stops the preview pictures
    const stills = fakeStills();
    expect((await drawPreviews(id, stills)).kind).toBe("known_failure");
    expect(stills.calls).toHaveLength(0);
  }, 120_000);

  it("refuses a stored body whose source no longer matches its fingerprint, and a changed scene after the look was approved", async () => {
    const id = await authored();
    expect((await drawPreviews(id)).kind).toBe("committed");
    await approveLook(id);
    const body = (await latestContent(db.pool, id, "scenes"))!.body as Record<string, unknown>;
    const damaged = { ...body, source: `${String(body.source)}// x\n` };
    await addContent(db.pool, id, "scenes", { body: damaged, sha256: sha256Hex(canonicalJson(damaged)) });
    const native = capture();
    expect((await renderWith(id, { native: { renderer: native, ready } })).kind).toBe("known_failure");
    expect((await stageRow(id, "render")).result).toMatchObject({ error: expect.stringMatching(/missing or damaged/) });
    expect(native.calls).toHaveLength(0);
  }, 120_000);

  it("is refused, with no fallback, when native rendering is off", async () => {
    const id = await authored();
    expect((await drawPreviews(id)).kind).toBe("committed");
    await approveLook(id);
    const container = capture();
    const out = await renderWith(id, { renderer: container, native: { renderer: capture(), ready } }, config);
    expect(out.kind).toBe("known_failure");
    expect((await stageRow(id, "render")).result).toMatchObject({ error: expect.stringMatching(/render\.native_3d/) });
    expect(container.calls).toHaveLength(0);
  }, 120_000);
});
