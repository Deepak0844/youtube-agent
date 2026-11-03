import type { LanguageModel } from "ai";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildEngineConfig } from "@/server/core/engine-config";
import { uuidv7 } from "@/server/core/ids";
import { BudgetRefusedError, NeedsDecisionError } from "@/server/core/paid-call";
import type { ModelRow } from "@/server/core/llm-catalog";
import type { PipelineReaders } from "@/server/db/pipeline";
import { readNextAction } from "@/server/db/pipeline";
import { canonicalJson, sha256Hex } from "@/server/core/content-hash";
import { GOOD_SCENE } from "../fixtures/tsx-good-scene";
import { targetFrames } from "@/server/core/tsx-prompt";
import type { StageHandler } from "@/server/core/stage-handler";
import type { StageOutcome } from "@/server/core/stage-runner";
import { approveGate, liveGateHash } from "@/server/db/approvals";
import { runStage } from "@/server/db/stage-runner-adapter";
import { claimStage, commitStage, insertQueuedStage } from "@/server/db/stages";
import { fallBackToSceneKit } from "@/server/db/tsx-fallback";
import { addContent, createVideoRow, latestContent } from "@/server/db/videos";
import { createLlmClient } from "@/server/llm/client";
import { fakeDraft, fakeModelStep } from "@/server/llm/fake-step";
import { createFakeImage } from "@/server/providers/media/fake";
import { createFakeRenderer } from "@/server/providers/renderer/fake";
import type { TsxRenderer, TsxRenderResult } from "@/server/providers/renderer";
import { createFakeVoice } from "@/server/providers/voice/fake";
import type { StageDeps } from "@/worker/stages/deps";
import { withAttempt } from "@/worker/stages/attempt";
import { ttsAttempt } from "@/worker/stages/tts";
import { tsxAuthorAttempt } from "@/worker/stages/tsx-author";
import { audioSeconds } from "@/worker/stages/voice-audio";
import { withTestDb, type TestDb } from "../support/db";

// The code-scene stage end to end on a fake model and a fake sandboxed renderer: success, retry with feedback, fall-back to the
// scene kit after the cap, and a budget refusal that must not retry or fall back. The real Docker render is not run here.
let db: TestDb;
let root: string;
const config = buildEngineConfig(new Map());
const SESSION = { kind: "session", sessionId: "11111111-1111-4111-8111-111111111111" } as const;
const GOOD_MP4 = path.resolve(process.cwd(), "tests/fixtures/video/good.mp4");

beforeAll(async () => {
  db = await withTestDb();
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "tsx-author-")));
});
afterAll(async () => {
  rmSync(root, { recursive: true, force: true });
  await db?.stop();
});
beforeEach(async () => {
  await db.reset();
  await db.pool.query("insert into budgets (scope, cap_micro_usd) values ('draft_run', 3000000), ('video:scene_kit', 2000000), ('video:tsx', 2000000), ('day', 15000000), ('month', 100000000)");
});

const ROW: ModelRow = { id: "00000000-0000-4000-8000-0000000000bb", provider: "anthropic", modelId: "m", label: "Fake", baseUrl: null, prices: { inputPerMTokMicro: 1_000_000, outputPerMTokMicro: 1_000_000 }, isFree: false, capabilities: { structuredOutput: true, toolUse: true, vision: false, nativeWebSearch: false, contextWindow: 128000 }, enabled: true, endpointKind: "hosted" };
const VROW: ModelRow = { ...ROW, id: "00000000-0000-4000-8000-0000000000cc", label: "Fake vision", capabilities: { ...ROW.capabilities, vision: true } };
/** `looks`: the replies of the vision model for the frame review (none = the review_frames route is the text-only ROW, so the review is skipped). */
const llmWith = (texts: string[], looks?: string[]) => {
  const step = fakeModelStep({ script: texts.map((text) => ({ text, toolCalls: [], usage: { inputTokens: 100, outputTokens: 50 } })) });
  const look = fakeModelStep({ script: (looks ?? []).map((text) => ({ text, toolCalls: [], usage: { inputTokens: 100, outputTokens: 50 } })) });
  return (scopes: string[]) => createLlmClient({
    db: db.pool,
    catalog: { route: async (stage) => (stage === "review_frames" && looks ? VROW : ROW), localServices: async () => [] },
    getKey: async () => null, buildModel: () => ({}) as LanguageModel, budgetScopes: () => scopes, makeStep: () => step, makeImagesStep: () => look,
  });
};
const verdict = (ok: boolean) => JSON.stringify({ ok, frames: [0, 100].map((frame) => ({ frame, shows_what_is_said: ok, problems: ok ? [] : ["object too small"], fix: ok ? "" : "Make the main object bigger" })) });

/** A scripted sandbox: one result per call; a success copies a real mp4 into the attempt folder like renderTsx does. */
function fakeTsx(results: Array<"ok" | { kind: "preflight" | "render" | "typecheck" | "review"; message: string; problems?: string[] }>): TsxRenderer & { sources: string[] } {
  const sources: string[] = [];
  return {
    sources,
    async renderTsx(ctx, input): Promise<TsxRenderResult> {
      sources.push(input.source);
      const r = results[sources.length - 1]!;
      const found = r !== "ok" || !input.review ? null : await input.review([0, 100].map((frame) => ({ frame, jpeg: new Uint8Array([0xff, 0xd8, frame]) })));
      if (found && found.length > 0) return { ok: false, error: { kind: "review", message: "A reviewer found problems.", problems: found } };
      if (r === "ok") {
        const outPath = path.join(ctx.attemptDir, input.outFile);
        copyFileSync(GOOD_MP4, outPath);
        const stills = ["tsx-frame-first.png", "tsx-frame-middle.png", "tsx-frame-last.png"];
        for (const f of stills) writeFileSync(path.join(ctx.attemptDir, f), "png");
        return { ok: true, outPath, image: "fake-image", stills };
      }
      return { ok: false, error: { kind: r.kind, message: r.message, problems: r.problems ?? [] } };
    },
  };
}

function mkDeps(over: Partial<StageDeps>): StageDeps {
  const voice = createFakeVoice();
  return { db: db.pool, root, voiceFor: async (a: { budgetScopes: string[] }) => ({ provider: voice.forScopes(a.budgetScopes), providerId: "fake", voice: "fake" }), image: createFakeImage(), renderer: createFakeRenderer(), ...over } as never;
}

const noProvider = { call: async () => Promise.reject(new Error("no provider in handler mode")) };
async function play(videoId: string, name: string, handler: StageHandler): Promise<StageOutcome> {
  const inputHash = `h-${name}-${uuidv7()}`;
  const stageRunId = await insertQueuedStage(db.pool, { videoId, name, inputHash });
  return runStage(db.pool, { provider: noProvider, ttlMs: 60_000, workerId: "w1", handler, config }, { stageRunId, inputHash });
}

/** A tsx video with an approved script, and narration made by the real tts stage on the fake voice. Returns the exact frame count the stage will ask for. */
async function tsxVideoWithNarration(): Promise<{ id: string; frames: number }> {
  const v = await createVideoRow(db.pool, { format: "short", kind: "tsx", language: "en", topic: "Why do octopuses have three hearts?" });
  const d = fakeDraft("en") as { title: string; narration: string };
  await addContent(db.pool, v.id, "script", { body: { title: d.title, narration: d.narration }, sha256: sha256Hex(canonicalJson(d)) });
  const beats = { beats: [{ id: "b1", text: "x", visual: "three hearts pulse" }, { id: "b2", text: "y", visual: "arrows to gills" }] };
  await addContent(db.pool, v.id, "beats", { body: beats, sha256: sha256Hex(canonicalJson(beats)) });
  const live = await liveGateHash(db.pool, v.id, "script");
  const ok = await approveGate(db.pool, { videoId: v.id, gate: "script", seenHash: live!.hash, actor: SESSION });
  if (!ok.ok) throw new Error(ok.reason);
  const tts = await play(v.id, "tts", withAttempt({ db: db.pool, root }, ttsAttempt(mkDeps({}))));
  if (tts.kind !== "committed") throw new Error(`tts ended ${tts.kind}`);
  const narration = (await latestContent(db.pool, v.id, "narration"))!.body as { file: string };
  const seconds = await audioSeconds(undefined, {} as never, path.join(root, "videos", v.id, narration.file));
  return { id: v.id, frames: targetFrames(seconds) };
}

const reply = (src: string) => "```tsx\n" + src + "\n```";
const withFrames = (n: number, extra = "") => GOOD_SCENE.replace("durationInFrames: 270", `durationInFrames: ${n}`) + extra;
const row = async (id: string) => (await db.pool.query("select kind, kind_origin from videos where id = $1", [id])).rows[0] as { kind: string; kind_origin: string | null };
const stageRow = async (id: string, name: string) => (await db.pool.query("select status, result from stage_runs where video_id = $1 and name = $2 order by created_at desc limit 1", [id, name])).rows[0] as { status: string; result: Record<string, unknown> };
const intentCount = async () => Number((await db.pool.query("select count(*) n from spend_intents")).rows[0].n);
const handler = (tsx: TsxRenderer, texts: string[], looks?: string[]) => withAttempt({ db: db.pool, root }, tsxAuthorAttempt(mkDeps({ tsx, makeLlm: llmWith(texts, looks) })));

describe("tsx_author stage", () => {
  it("success: the accepted source is saved as content tsx, render.mp4 is promoted, the video stays a tsx video", async () => {
    const { id, frames } = await tsxVideoWithNarration();
    const tsx = fakeTsx(["ok"]);
    const out = await play(id, "tsx_author", handler(tsx, [reply(withFrames(frames))]));
    expect(out.kind).toBe("committed");
    expect(tsx.sources).toEqual([withFrames(frames)]);
    const saved = await latestContent(db.pool, id, "tsx");
    expect(saved?.body).toMatchObject({ source: withFrames(frames), durationInFrames: frames, attempts: 1, image: "fake-image" });
    expect(saved?.sha256).toBe(sha256Hex(canonicalJson(saved!.body)));
    expect(readFileSync(path.join(root, "videos", id, "render.mp4")).equals(readFileSync(GOOD_MP4))).toBe(true);
    expect(await row(id)).toEqual({ kind: "tsx", kind_origin: null });
    for (const f of ["first", "middle", "last"]) expect(existsSync(path.join(root, "videos", id, `tsx-frame-${f}.png`))).toBe(true); // preflight stills kept
    expect((await stageRow(id, "tsx_author")).result).toMatchObject({ fellBack: false, attempts: 1 });
    expect(await intentCount()).toBeGreaterThanOrEqual(1);
  });

  it("frame review ok: one vision call, the verdict is saved as content frame_review and in the stage result", async () => {
    const { id, frames } = await tsxVideoWithNarration();
    const before = await intentCount();
    const out = await play(id, "tsx_author", handler(fakeTsx(["ok"]), [reply(withFrames(frames))], [verdict(true)]));
    expect(out.kind).toBe("committed");
    expect(await intentCount()).toBe(before + 2); // one author call and one review call, both reserved
    expect((await latestContent(db.pool, id, "frame_review"))?.body).toMatchObject({ status: "done", ok: true, attempt: 1 });
    expect((await stageRow(id, "tsx_author")).result).toMatchObject({ fellBack: false, frameReview: { status: "done", ok: true } });
  });

  it("frame review not ok with attempts left: the problem list goes back to the author, the second file is accepted, still 3 attempts at most", async () => {
    const { id, frames } = await tsxVideoWithNarration();
    const before = await intentCount();
    const tsx = fakeTsx(["ok", "ok"]);
    const out = await play(id, "tsx_author", handler(tsx, [reply(withFrames(frames)), reply(withFrames(frames, "// bigger\n"))], [verdict(false), verdict(true)]));
    expect(out.kind).toBe("committed");
    expect(tsx.sources).toHaveLength(2);
    expect(await intentCount()).toBe(before + 4); // 2 author + 2 review
    expect((await latestContent(db.pool, id, "tsx"))?.body).toMatchObject({ attempts: 2 });
    expect((await latestContent(db.pool, id, "frame_review"))?.body).toMatchObject({ status: "done", ok: true, attempt: 2 });
  });

  it("frame review not ok on every attempt: the last render is accepted with a warning, the video is not blocked", async () => {
    const { id, frames } = await tsxVideoWithNarration();
    const out = await play(id, "tsx_author", handler(fakeTsx(["ok", "ok", "ok"]), [reply(withFrames(frames)), reply(withFrames(frames, "// b\n")), reply(withFrames(frames, "// c\n"))], [verdict(false), verdict(false), verdict(false)]));
    expect(out.kind).toBe("committed");
    expect(await row(id)).toEqual({ kind: "tsx", kind_origin: null });
    expect((await stageRow(id, "tsx_author")).result).toMatchObject({ fellBack: false, attempts: 3, frameReview: { status: "done", ok: false } });
  });

  it("frame review unavailable (bad JSON from the vision model): neither a pass nor a fail, the video goes on", async () => {
    const { id, frames } = await tsxVideoWithNarration();
    const out = await play(id, "tsx_author", handler(fakeTsx(["ok"]), [reply(withFrames(frames))], ["I cannot tell"]));
    expect(out.kind).toBe("committed");
    expect((await latestContent(db.pool, id, "frame_review"))?.body).toMatchObject({ status: "unavailable" });
    expect((await stageRow(id, "tsx_author")).result).toMatchObject({ fellBack: false, attempts: 1 });
  });

  it("no vision model: the review is skipped with a plain reason, no vision call, and the video goes on", async () => {
    const { id, frames } = await tsxVideoWithNarration();
    const before = await intentCount();
    const out = await play(id, "tsx_author", handler(fakeTsx(["ok"]), [reply(withFrames(frames))]));
    expect(out.kind).toBe("committed");
    expect(await intentCount()).toBe(before + 1);
    expect((await latestContent(db.pool, id, "frame_review"))?.body).toMatchObject({ status: "skipped", reason: expect.stringContaining("frame review skipped: no vision model") });
  });

  it("retry: a file the checker refuses is sent back with the problem, and the corrected file is rendered once", async () => {
    const { id, frames } = await tsxVideoWithNarration();
    const before = await intentCount();
    const tsx = fakeTsx(["ok"]);
    const bad = withFrames(frames).replace("useCurrentFrame();", "useCurrentFrame(); const t = Date.now();");
    const out = await play(id, "tsx_author", handler(tsx, [reply(bad), reply(withFrames(frames))]));
    expect(out.kind).toBe("committed");
    expect(tsx.sources).toEqual([withFrames(frames)]); // the refused file never reached the sandbox
    expect((await stageRow(id, "tsx_author")).result).toMatchObject({ fellBack: false, attempts: 2 });
    expect(await intentCount()).toBe(before + 2); // two reserved model calls, nothing hidden
    expect((await latestContent(db.pool, id, "tsx"))?.body).toMatchObject({ attempts: 2 });
  });

  it("fall-back: three failed attempts switch the video to scene_kit with an audit event; draft stays up to date and build is next", async () => {
    const { id, frames } = await tsxVideoWithNarration();
    // Mark draft as done under the tsx route, as the pipeline would have.
    const readers: PipelineReaders = { approvedGates: async () => new Set(["script"] as const), feedback: async () => null };
    const draftHash = (await readNextAction(db.pool, id, readers)) as { stage: string; inputHash: string };
    expect(draftHash).toMatchObject({ kind: "enqueue", stage: "draft" });
    const draftId = await insertQueuedStage(db.pool, { videoId: id, name: "draft", inputHash: draftHash.inputHash });
    const draftClaim = await claimStage(db.pool, { id: draftId, inputHash: draftHash.inputHash, workerId: "w0", ttlMs: 60_000 });
    expect(await commitStage(db.pool, draftClaim!, { ok: true })).toBe(true);
    expect(await readNextAction(db.pool, id, readers)).toMatchObject({ kind: "enqueue", stage: "pictures" });

    const tsx = fakeTsx([{ kind: "preflight", message: "The preview frames show a problem.", problems: ["Frame 0 is black."] }, { kind: "render", message: "The TSX render failed (exit 1)." }, { kind: "typecheck", message: "The scene file has type errors.", problems: ["line 3: x"] }]);
    const texts = [reply(withFrames(frames, "// a\n")), reply(withFrames(frames, "// b\n")), reply(withFrames(frames, "// c\n"))];
    const before = await intentCount();
    const out = await play(id, "tsx_author", handler(tsx, texts));
    expect(out.kind).toBe("committed");
    expect(tsx.sources).toHaveLength(3);
    expect(await intentCount()).toBe(before + 3); // the cap: three model calls, not four
    expect(await row(id)).toEqual({ kind: "scene_kit", kind_origin: "tsx" });
    expect((await stageRow(id, "tsx_author")).result).toMatchObject({ fellBack: true, switched: true, attempts: 3, why: "cap" });
    expect(await latestContent(db.pool, id, "tsx")).toBeNull();
    expect(existsSync(path.join(root, "videos", id, "render.mp4"))).toBe(false);
    const audit = await db.pool.query("select detail from audit_log where event = 'video.tsx_fallback'");
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].detail).toMatchObject({ videoId: id, attempts: 3 });
    expect(JSON.stringify(audit.rows[0].detail)).not.toContain("useCurrentFrame");
    // The parameters hash still names the original kind: draft is not stale, the route is now the scene kit (pictures were not run yet).
    expect(await readNextAction(db.pool, id, readers)).toMatchObject({ kind: "enqueue", stage: "pictures" });
  });

  it("a retry after a crash between the switch and the commit finishes cleanly: scene_kit with origin tsx is already done", async () => {
    const { id } = await tsxVideoWithNarration();
    await db.pool.query("update videos set kind = 'scene_kit', kind_origin = 'tsx' where id = $1", [id]);
    const out = await play(id, "tsx_author", handler(fakeTsx([]), []));
    expect(out.kind).toBe("committed");
    expect((await stageRow(id, "tsx_author")).result).toMatchObject({ fellBack: true, switched: false, resumed: true });
  });

  it("fallBackToSceneKit refuses an expired lease and a cancel request, and switches nothing", async () => {
    const { id } = await tsxVideoWithNarration();
    const hash = `h-lease-${uuidv7()}`;
    const stageRunId = await insertQueuedStage(db.pool, { videoId: id, name: "tsx_author", inputHash: hash });
    const claim = (await claimStage(db.pool, { id: stageRunId, inputHash: hash, workerId: "w1", ttlMs: 60_000 }))!;
    const detail = { attempts: 3, step: "check", why: "cap" };
    await db.pool.query("update stage_runs set cancel_requested = true where id = $1", [stageRunId]);
    await expect(fallBackToSceneKit(db.pool, claim, id, detail)).rejects.toThrow();
    await db.pool.query("update stage_runs set cancel_requested = false, lease_until = now() - interval '1 minute' where id = $1", [stageRunId]);
    await expect(fallBackToSceneKit(db.pool, claim, id, detail)).rejects.toThrow();
    expect(await row(id)).toEqual({ kind: "tsx", kind_origin: null });
    await db.pool.query("update stage_runs set lease_until = now() + interval '1 minute' where id = $1", [stageRunId]);
    expect(await fallBackToSceneKit(db.pool, claim, id, detail)).toBe(true);
    expect(await fallBackToSceneKit(db.pool, claim, id, detail)).toBe(false); // second call: already switched, no second audit row
    expect(await row(id)).toEqual({ kind: "scene_kit", kind_origin: "tsx" });
  });

  it.each([
    ["a budget refusal", () => new BudgetRefusedError("k2")],
    ["an unclear paid outcome", () => new NeedsDecisionError("run", "k2", 5)],
  ])("%s on the second attempt stops for the owner: no more model calls, no render, no fall-back", async (_n, mkErr) => {
    const { id, frames } = await tsxVideoWithNarration();
    const inner = llmWith([reply(withFrames(frames)), reply(withFrames(frames, "// b\n"))]);
    let calls = 0;
    const makeLlm = (scopes: string[]) => {
      const llm = inner(scopes);
      return { ...llm, agent: (...a: Parameters<typeof llm.agent>) => (++calls === 2 ? Promise.reject(mkErr()) : llm.agent(...a)) } as typeof llm;
    };
    const tsx = fakeTsx([{ kind: "render", message: "The TSX render failed (exit 1)." }]);
    const out = await play(id, "tsx_author", withAttempt({ db: db.pool, root }, tsxAuthorAttempt(mkDeps({ tsx, makeLlm }))));
    expect(out.kind).not.toBe("committed");
    expect(calls).toBe(2);
    expect(tsx.sources).toHaveLength(1);
    expect(await row(id)).toEqual({ kind: "tsx", kind_origin: null });
    expect(await latestContent(db.pool, id, "tsx")).toBeNull();
  });

  it("refuses with a plain sentence when no model or no sandbox is wired, and for a video that is not a code-scene video", async () => {
    const { id } = await tsxVideoWithNarration();
    expect((await play(id, "tsx_author", withAttempt({ db: db.pool, root }, tsxAuthorAttempt(mkDeps({ tsx: fakeTsx([]) }))))).kind).toBe("known_failure");
    expect((await play(id, "tsx_author", withAttempt({ db: db.pool, root }, tsxAuthorAttempt(mkDeps({ makeLlm: llmWith([]) }))))).kind).toBe("known_failure");
    await db.pool.query("update videos set kind = 'scene_kit' where id = $1", [id]);
    expect((await play(id, "tsx_author", handler(fakeTsx([]), []))).kind).toBe("known_failure");
  });
});
