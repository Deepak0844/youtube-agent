import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildEngineConfig } from "@/server/core/engine-config";
import { buildCostPlan, costPlanBody } from "@/server/core/cost-plan";
import { uuidv7 } from "@/server/core/ids";
import { LeaseLostError } from "@/server/core/paid-call";
import { expectedInputHash, nextActions, stagePlan, type PipelineView, type StageName } from "@/server/core/pipeline-plan";
import { createStageContext, type StageContext, type StageHandler } from "@/server/core/stage-handler";
import type { StageOutcome } from "@/server/core/stage-runner";
import { approvalState, approveGate, liveGateHash } from "@/server/db/approvals";
import { periodScopes } from "@/server/db/budget-scopes";
import { createPgPaidCallPorts } from "@/server/db/paid-call-adapter";
import { runStage } from "@/server/db/stage-runner-adapter";
import { getBudget } from "@/server/db/spend";
import { claimStage, insertQueuedStage } from "@/server/db/stages";
import { addContent, createVideoRow, latestContent } from "@/server/db/videos";
import { fakeDraft } from "@/server/llm/fake-step";
import { createFakeImage } from "@/server/providers/media/fake";
import type { ImageProvider } from "@/server/providers/media";
import { createFakeRenderer } from "@/server/providers/renderer/fake";
import { createFakeVoice } from "@/server/providers/voice/fake";
import { attemptDir } from "@/server/storage/paths";
import { sweepLostAttempts } from "@/server/storage/store";
import { createStageDispatcher, dryRunHandlers } from "@/worker/handlers";
import { finishAttempt, prepareAttempt, withAttempt, type AttemptHandler } from "@/worker/stages/attempt";
import { buildAttempt } from "@/worker/stages/build";
import type { StageDeps } from "@/worker/stages/deps";
import { dryRunDraftHandler } from "@/worker/stages/draft";
import { generateAttempt } from "@/worker/stages/generate";
import { qaAttempt } from "@/worker/stages/qa";
import { renderAttempt } from "@/worker/stages/render";
import { sfxAttempt } from "@/worker/stages/sfx";
import { ttsAttempt } from "@/worker/stages/tts";
import { voiceAttempt } from "@/worker/stages/voice";
import { sha256Hex, canonicalJson } from "@/server/core/content-hash";
import { assertFfprobeAvailable } from "../support/tools";
import { withTestDb, type TestDb } from "../support/db";

const execFileAsync = promisify(execFile);
let db: TestDb;
let root: string;
const config = buildEngineConfig(new Map());
const SESSION = { kind: "session", sessionId: "11111111-1111-4111-8111-111111111111" } as const;
const FIXTURES = path.resolve(process.cwd(), "tests/fixtures/video");

beforeAll(async () => {
  assertFfprobeAvailable();
  db = await withTestDb();
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "stages-dry-")));
});
afterAll(async () => {
  rmSync(root, { recursive: true, force: true });
  await db?.stop();
});
beforeEach(async () => {
  await db.reset();
  await db.pool.query("insert into budgets (scope, cap_micro_usd) values ('draft_run', 3000000), ('video:scene_kit', 2000000), ('day', 15000000), ('month', 100000000)");
});

// --- helpers -----------------------------------------------------------------------------------------------------------

function mkDeps(over: Partial<StageDeps> = {}): StageDeps & { voice: ReturnType<typeof createFakeVoice>; image: ReturnType<typeof createFakeImage>; renderer: ReturnType<typeof createFakeRenderer> } {
  return { db: db.pool, root, voice: createFakeVoice(), image: createFakeImage(), renderer: createFakeRenderer(), ...over } as never;
}

const newVideo = (language: "en" | "hi" = "en") => createVideoRow(db.pool, { format: "short", kind: "scene_kit", language, topic: "Why do octopuses have three hearts?" });

/** Script + beats as the Draft stage would save them, without running Draft. */
async function seedScript(videoId: string, beats = 3): Promise<void> {
  const d = fakeDraft("en") as { title: string; narration: string };
  await addContent(db.pool, videoId, "script", { body: { title: d.title, narration: d.narration }, sha256: sha256Hex(canonicalJson(d)) });
  const b = { beats: Array.from({ length: beats }, (_, i) => ({ id: `b${i + 1}`, text: "x" })) };
  await addContent(db.pool, videoId, "beats", { body: b, sha256: sha256Hex(canonicalJson(b)) });
}

async function stageCtx(videoId: string, name: string, workerId = "w1"): Promise<{ ctx: StageContext; stageId: string; claim: NonNullable<Awaited<ReturnType<typeof claimStage>>> }> {
  const stageId = await insertQueuedStage(db.pool, { videoId, name, inputHash: "h" });
  const claim = (await claimStage(db.pool, { id: stageId, inputHash: "h", workerId, ttlMs: 600_000 }))!;
  const ctx = createStageContext({ stage: { id: stageId, name, inputHash: "h", videoId }, claim, config, signal: new AbortController().signal, paid: createPgPaidCallPorts(db.pool) }).ctx;
  return { ctx, stageId, claim };
}

const noProvider = { call: async () => Promise.reject(new Error("no provider in handler mode")) };
/** Runs one stage through the real runner (claim, heartbeat, handler, commit) with a handler from the dispatcher. */
async function play(videoId: string, name: StageName, handler: StageHandler): Promise<StageOutcome> {
  const inputHash = `h-${name}-${uuidv7()}`;
  const stageRunId = await insertQueuedStage(db.pool, { videoId, name, inputHash });
  return runStage(db.pool, { provider: noProvider, ttlMs: 60_000, workerId: "w1", handler, config }, { stageRunId, inputHash });
}

async function approveCost(videoId: string): Promise<void> {
  const live = await liveGateHash(db.pool, videoId, "cost");
  const r = await approveGate(db.pool, { videoId, gate: "cost", seenHash: live!.hash, actor: SESSION });
  if (!r.ok) throw new Error(r.reason);
}

const ORDER: StageName[] = ["draft", "build", "generate", "tts", "render", "voice", "sfx", "qa"];
async function chain(videoId: string, until: StageName, handlers = dryRunHandlers(mkDeps())): Promise<StageOutcome[]> {
  const dispatcher = createStageDispatcher(handlers, 2);
  const out: StageOutcome[] = [];
  for (const s of ORDER) {
    const o = await play(videoId, s, dispatcher);
    out.push(o);
    if (o.kind !== "committed") throw new Error(`${s} ended ${o.kind}: ${JSON.stringify((await db.pool.query("select result from stage_runs where video_id=$1 and name=$2 order by created_at desc limit 1", [videoId, s])).rows[0])}`);
    if (s === "build") await approveCost(videoId);
    if (s === until) break;
  }
  return out;
}

function snapshot(dir: string): Map<string, string> {
  const m = new Map<string, string>();
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const p = path.join(d, name);
      const st = lstatSync(p);
      if (st.isDirectory()) walk(p);
      else m.set(p, `${st.size}:${st.mtimeMs}`);
    }
  };
  walk(dir);
  return m;
}

const stageResult = async (videoId: string, name: string) =>
  (await db.pool.query("select status, result from stage_runs where video_id = $1 and name = $2 order by created_at desc limit 1", [videoId, name])).rows[0] as { status: string; result: Record<string, unknown> };
const intentCount = async () => Number((await db.pool.query("select count(*) n from spend_intents")).rows[0].n);
const contentCount = async (videoId: string, kind: string) => Number((await db.pool.query("select count(*) n from video_content where video_id = $1 and kind = $2", [videoId, kind])).rows[0].n);

// --- the handlers -------------------------------------------------------------------------------------------------------

describe("dry-run stage handlers", () => {
  it("runs the whole route on fakes and saves the video with the SHA-256 of its bytes", async () => {
    const v = await newVideo();
    const outcomes = await chain(v.id, "qa");
    expect(outcomes.map((o) => o.kind)).toEqual(Array(8).fill("committed"));

    const video = await latestContent(db.pool, v.id, "video");
    expect(video?.filePath).toBe(`videos/${v.id}/final.mp4`);
    const bytes = readFileSync(path.join(root, video!.filePath!));
    expect(video?.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(bytes.equals(readFileSync(path.join(FIXTURES, "good.mp4")))).toBe(true);
    const narration = (await latestContent(db.pool, v.id, "narration"))!.body as { file: string; word_timings: string; audio_sha256: string };
    expect(narration.word_timings).toBe("estimated");
    expect(createHash("sha256").update(readFileSync(path.join(root, "videos", v.id, narration.file))).digest("hex")).toBe(narration.audio_sha256);
    for (const f of ["scene.json", "render.mp4", "voiced.mp4", "review-first.png", "review-last.png"]) expect(existsSync(path.join(root, "videos", v.id, f))).toBe(true);
    // Attempt folders were emptied by promotion (only the marker may remain).
    for (const d of readdirSync(path.join(root, "videos", v.id)).filter((n) => n.startsWith("attempt-"))) {
      expect(readdirSync(path.join(root, "videos", v.id, d)).filter((n) => !n.startsWith(".promote-marker"))).toEqual([]);
    }
    expect(await liveGateHash(db.pool, v.id, "video")).not.toBeNull();
  });

  it("each_handler_writes_only_inside_its_attempt_dir", async () => {
    const deps = mkDeps();
    const v = await newVideo();
    const attempts: Array<[StageName, (d: StageDeps) => AttemptHandler]> = [
      ["build", buildAttempt], ["generate", generateAttempt], ["tts", ttsAttempt], ["render", renderAttempt], ["voice", voiceAttempt], ["sfx", sfxAttempt], ["qa", qaAttempt],
    ];
    // Draft first (the real Draft handler): it writes no file at all.
    const before0 = snapshot(root);
    expect((await play(v.id, "draft", dryRunDraftHandler(db.pool))).kind).toBe("committed");
    expect(snapshot(root)).toEqual(before0);

    for (const [name, make] of attempts) {
      const { ctx } = await stageCtx(v.id, name);
      const dir = await prepareAttempt(ctx, root);
      expect(dir).toBe(attemptDir(root, v.id, ctx.claim.stageRunId, ctx.claim.fence));
      const before = snapshot(root);
      const out = await make(deps)(ctx);
      const after = snapshot(root);
      for (const [p, sig] of after) if (before.get(p) !== sig) expect(p.startsWith(dir + path.sep), `${name} wrote ${p} outside ${dir}`).toBe(true);
      for (const p of before.keys()) expect(after.has(p), `${name} removed ${p}`).toBe(true);
      expect(out.files.length).toBeGreaterThan(0);
      for (const f of out.files) expect(after.has(path.join(dir, f)), `${name} promised ${f}`).toBe(true);
      await finishAttempt({ db: db.pool, root }, ctx, out);
      // The runner's commit path would follow; commit by hand so the next stage sees a finished predecessor.
      await db.pool.query("update stage_runs set status='succeeded' where id=$1", [ctx.stage.id]);
      if (name === "build") await approveCost(v.id);
    }
  });

  it("stale_attempt_outputs_are_not_promoted", async () => {
    const v = await newVideo();
    await seedScript(v.id);
    const deps = mkDeps();
    const { ctx, stageId } = await stageCtx(v.id, "build", "w1");
    const dir = await prepareAttempt(ctx, root);
    const out = await buildAttempt(deps)(ctx);
    expect(existsSync(path.join(dir, "scene.json"))).toBe(true);

    // Another worker takes the stage over (lease expired, fence 2) while this attempt is still finishing.
    await db.ownerPool.query("update stage_runs set status='queued', lease_owner=null, lease_until=null where id=$1", [stageId]);
    const second = await claimStage(db.pool, { id: stageId, inputHash: "h", workerId: "w2", ttlMs: 600_000 });
    expect(second?.fence).toBe(2);

    await expect(finishAttempt({ db: db.pool, root }, ctx, out)).rejects.toBeInstanceOf(LeaseLostError);
    expect(existsSync(path.join(root, "videos", v.id, "scene.json"))).toBe(false); // nothing promoted
    expect(await contentCount(v.id, "cost_plan")).toBe(0); // nothing saved
    expect(existsSync(path.join(dir, "scene.json"))).toBe(true); // stays in the lost attempt's folder...
    expect(await sweepLostAttempts(db.pool, { root })).toBe(1); // ...where the sweep removes it
    expect(existsSync(dir)).toBe(false);
  });

  it("a resumed Generate replays finished images from storage: no second provider call, files rebuilt", async () => {
    const v = await newVideo();
    await seedScript(v.id);
    const deps = mkDeps();
    expect((await play(v.id, "build", withAttempt({ db: db.pool, root }, buildAttempt(deps)))).kind).toBe("committed");
    await approveCost(v.id);

    const { ctx, stageId } = await stageCtx(v.id, "generate");
    await prepareAttempt(ctx, root);
    await generateAttempt(deps)(ctx); // all three images bought, then the worker "dies" before promoting
    expect(deps.image.totalCalls()).toBe(3);

    await db.ownerPool.query("update stage_runs set status='queued', lease_owner=null, lease_until=null where id=$1", [stageId]);
    const claim2 = (await claimStage(db.pool, { id: stageId, inputHash: "h", workerId: "w2", ttlMs: 600_000 }))!;
    const ctx2 = createStageContext({ stage: ctx.stage, claim: claim2, config, signal: new AbortController().signal, paid: createPgPaidCallPorts(db.pool) }).ctx;
    const done = (await withAttempt({ db: db.pool, root }, generateAttempt(deps))(ctx2)) as { files: string[] };
    expect(deps.image.totalCalls()).toBe(3);
    expect(done.files).toHaveLength(3);
    for (const f of done.files) expect(existsSync(path.join(root, "videos", v.id, f))).toBe(true);
    expect(await intentCount()).toBe(3);
  });

  it("a failed QA saves no video and says why", async () => {
    const v = await newVideo();
    const deps = mkDeps({ renderer: createFakeRenderer({ fixture: path.join(FIXTURES, "short.mp4") }) });
    await expect(chain(v.id, "qa", dryRunHandlers(deps))).rejects.toThrow(/qa ended known_failure/);
    expect((await stageResult(v.id, "qa")).result).toMatchObject({ error: expect.stringMatching(/qa_failed: .*length is 3\.0s/) });
    expect(await contentCount(v.id, "video")).toBe(0);
  });

  it("render takes a slot in the render semaphore", async () => {
    const v1 = await newVideo();
    const v2 = await newVideo();
    let inFlight = 0;
    let peak = 0;
    const base = createFakeRenderer();
    const renderer = { ...base, render: async (c: StageContext, a: Parameters<typeof base.render>[1]) => { inFlight++; peak = Math.max(peak, inFlight); await new Promise((r) => setTimeout(r, 150)); try { return await base.render(c, a); } finally { inFlight--; } } };
    const handlers = dryRunHandlers(mkDeps({ renderer }));
    await chain(v1.id, "tts", handlers);
    await chain(v2.id, "tts", handlers);
    const one = createStageDispatcher(handlers, 1);
    const outs = await Promise.all([play(v1.id, "render", one), play(v2.id, "render", one)]);
    expect(outs.map((o) => o.kind)).toEqual(["committed", "committed"]);
    expect(peak).toBe(1);
  });
});

// --- money --------------------------------------------------------------------------------------------------------------

describe("paid generation is bounded by the approved quote", () => {
  async function approvedVideo(deps: StageDeps): Promise<string> {
    const v = await newVideo();
    await seedScript(v.id);
    expect((await play(v.id, "build", withAttempt({ db: db.pool, root }, buildAttempt(deps)))).kind).toBe("committed");
    await approveCost(v.id);
    return v.id;
  }
  const generate = (deps: StageDeps) => withAttempt({ db: db.pool, root }, generateAttempt(deps));

  it("generate_cannot_exceed_the_approved_quote", async () => {
    // The plan quotes 3 x 4000 = 12000. The provider charges 9000 for the first image: reserved + spent + next quote > 12000.
    const deps = mkDeps({ image: createFakeImage({ priceMicroUsd: 9000 }) });
    const id = await approvedVideo(deps);
    const out = await play(id, "generate", generate(deps));
    expect(out.kind).toBe("budget_refused");
    expect(deps.image.totalCalls()).toBe(1); // the second image was never requested
    expect((await stageResult(id, "generate")).status).toBe("needs_decision");
    const state = await approvalState(db.pool, id, "cost");
    const scope = `quote:${id}:${(state.approved ? state.hash : "").slice(0, 16)}`;
    expect(await getBudget(db.pool, scope)).toMatchObject({ capMicroUsd: 12000, spentMicroUsd: 9000, reservedMicroUsd: 0 });
  });

  it("a plan whose items cost more than its approved quote is refused before any money moves", async () => {
    const deps = mkDeps();
    const v = await newVideo();
    await seedScript(v.id);
    const body = costPlanBody(buildCostPlan([{ kind: "image", provider: "fake-image", quoteMicroUsd: 5000 }, { kind: "image", provider: "fake-image", quoteMicroUsd: 5000 }], "scene_kit"));
    body.quote = { micro_usd: "8000" }; // hand-edited down: still a complete, approvable plan
    await addContent(db.pool, v.id, "cost_plan", { body, sha256: sha256Hex(canonicalJson(body)) });
    await approveCost(v.id);
    const out = await play(v.id, "generate", generate(deps));
    expect(out.kind).toBe("known_failure");
    expect(deps.image.totalCalls()).toBe(0);
    expect(await intentCount()).toBe(0);
  });

  it("changing_provider_after_approval_reopens_the_cost_gate", async () => {
    const deps = mkDeps();
    const id = await approvedVideo(deps);
    expect((await approvalState(db.pool, id, "cost")).approved).toBe(true);
    const old = (await latestContent(db.pool, id, "cost_plan"))!.body as { items: Array<{ kind: "image"; provider: string; quoteMicroUsd: number }> };
    const changed = costPlanBody(buildCostPlan(old.items.map((i) => ({ ...i, provider: "other-image" })), "scene_kit"));
    await addContent(db.pool, id, "cost_plan", { body: changed, sha256: sha256Hex(canonicalJson(changed)) });

    expect((await approvalState(db.pool, id, "cost")).approved).toBe(false); // the owner must approve the new plan
    const out = await play(id, "generate", generate(deps));
    expect(out.kind).toBe("known_failure");
    expect(deps.image.totalCalls()).toBe(0);
    await approveCost(id);
    expect((await play(id, "generate", generate(deps))).kind).toBe("known_failure"); // approved, but no such provider is set up
    expect(deps.image.totalCalls()).toBe(0);
  });

  it("a plan edited while images are being made stops the run: nothing more is bought", async () => {
    const deps = mkDeps();
    const id = await approvedVideo(deps);
    const old = (await latestContent(db.pool, id, "cost_plan"))!.body as { items: Array<{ kind: "image"; provider: string; quoteMicroUsd: number }> };
    const inner = deps.image;
    let first = true;
    const image: ImageProvider = {
      generate: async (c, a) => {
        const r = await inner.generate(c, a);
        if (first) {
          first = false;
          const changed = costPlanBody(buildCostPlan(old.items.map((i) => ({ ...i, quoteMicroUsd: i.quoteMicroUsd + 1 })), "scene_kit"));
          await addContent(db.pool, id, "cost_plan", { body: changed, sha256: sha256Hex(canonicalJson(changed)) });
        }
        return r;
      },
    };
    const out = await play(id, "generate", generate({ ...deps, image }));
    expect(out.kind).toBe("known_failure");
    expect(inner.totalCalls()).toBe(1);
    expect((await stageResult(id, "generate")).result).toMatchObject({ error: expect.stringMatching(/changed while images were being made/) });
  });

  it("plan_over_the_cap_is_blocked_before_spending", async () => {
    const v = await newVideo();
    await seedScript(v.id);
    // 3 x 0.8 USD = 2.4 USD against the 2 USD per-video cap.
    const out = await play(v.id, "build", withAttempt({ db: db.pool, root }, buildAttempt(mkDeps({ imageQuoteMicroUsd: 800_000 }))));
    expect(out.kind).toBe("known_failure");
    expect((await stageResult(v.id, "build")).result).toMatchObject({ error: expect.stringMatching(/plan_over_the_cap.*\$2\.40.*\$2\.00.*this video's cap.*Nothing was spent/) });
    expect(await contentCount(v.id, "cost_plan")).toBe(0);
    expect(await intentCount()).toBe(0);
    expect(existsSync(path.join(root, "videos", v.id, "scene.json"))).toBe(false);
  });

  it("a plan that fits the video cap but not what is left of today is blocked too", async () => {
    const v = await newVideo();
    await seedScript(v.id);
    await db.pool.query("update budgets set cap_micro_usd = 10000 where scope = 'day'");
    const out = await play(v.id, "build", withAttempt({ db: db.pool, root }, buildAttempt(mkDeps())));
    expect(out.kind).toBe("known_failure");
    expect((await stageResult(v.id, "build")).result).toMatchObject({ error: expect.stringMatching(/\$0\.01 is left under today's cap/) });
  });

  it("daily_cap_stops_the_queue_instead_of_overspending", async () => {
    // 30 videos are planned and approved while the day cap is wide. Then the owner (or the day) lowers it to 50000: each video
    // buys one image (4000) and narration (reserve 10000, charged 1000), so the queue must stop part way, not overspend.
    const deps = mkDeps({ maxImages: 1 });
    const handlers = dryRunHandlers(deps);
    const dispatcher = createStageDispatcher(handlers, 2);
    const ids: string[] = [];
    for (let i = 0; i < 30; i++) {
      const v = await newVideo();
      await seedScript(v.id, 1);
      expect((await play(v.id, "build", dispatcher)).kind).toBe("committed");
      await approveCost(v.id);
      ids.push(v.id);
    }
    await db.pool.query("update budgets set cap_micro_usd = 50000 where scope = 'day'");
    const outcomes: string[] = [];
    for (const id of ids) {
      const gen = await play(id, "generate", dispatcher);
      outcomes.push(gen.kind);
      if (gen.kind === "committed") outcomes.push((await play(id, "tts", dispatcher)).kind);
    }
    const [dayScope] = (await periodScopes(db.pool))[0]!;
    const day = (await getBudget(db.pool, dayScope))!;
    expect(day.spentMicroUsd).toBeLessThanOrEqual(day.capMicroUsd);
    expect(day.reservedMicroUsd).toBe(0);
    expect(outcomes.filter((o) => o === "committed").length).toBeGreaterThan(0);
    expect(outcomes.filter((o) => o === "budget_refused").length).toBeGreaterThan(0); // the queue stopped, it did not overspend
    // Once refused, the provider was never called again for later videos: calls == settled intents.
    const settled = Number((await db.pool.query("select count(*) n from spend_intents where status = 'done'")).rows[0].n);
    expect(deps.image.totalCalls() + deps.voice.totalCalls()).toBe(settled);
    // No intent is stuck holding a reservation.
    expect(Number((await db.pool.query("select count(*) n from spend_intents where status in ('pending','unknown')")).rows[0].n)).toBe(0);
  });
});

// --- scripts/dry-run.ts -------------------------------------------------------------------------------------------------

describe("scripts/dry-run.ts", () => {
  const run = (args: string[], env: Record<string, string> = {}) =>
    execFileAsync(process.execPath, ["--import", "tsx", "scripts/dry-run.ts", ...args], {
      cwd: process.cwd(),
      env: { ...process.env, DATABASE_URL: db.pool.options.connectionString!, STORAGE_ROOT: root, ENGINE_DRY_RUN: "1", ...env },
      timeout: 100_000,
    });

  it("stops at the owner's first gate by default, and refuses to run without ENGINE_DRY_RUN=1", async () => {
    const r = await run([]);
    expect(r.stdout).toMatch(/Waiting for you at the script gate\. Nothing was approved/);
    expect(Number((await db.pool.query("select count(*) n from approvals")).rows[0].n)).toBe(0);
    await expect(run([], { ENGINE_DRY_RUN: "0" })).rejects.toMatchObject({ stderr: expect.stringMatching(/Set ENGINE_DRY_RUN=1/) });
  });

  it("with --auto-approve it finishes and prints the path of a video that exists", async () => {
    const r = await run(["--auto-approve"]);
    const last = r.stdout.trim().split("\n").at(-1)!;
    expect(last).toMatch(new RegExp(`^${root}/videos/[0-9a-f-]{36}/final\\.mp4$`));
    expect(existsSync(last)).toBe(true);
    expect((await db.pool.query("select gate from approvals order by seq")).rows.map((x) => x.gate)).toEqual(["script", "cost"]); // never the video, evidence or publish gates
  });
});

// --- the route ----------------------------------------------------------------------------------------------------------

describe("stage inputs", () => {
  const flags = { requireEvidence: true, paidGeneration: true };
  const view = (script: string): PipelineView => ({
    kind: "scene_kit", format: "short", flags, paramsHash: "p", feedback: null,
    content: { script, beats: "b", cost_plan: "c", narration: "n" }, runs: {}, approved: new Set(),
  });
  const chainHashes = (v: PipelineView): Record<string, string> => {
    const out: Record<string, string> = {};
    let prev: string | null = null;
    for (const step of stagePlan(v.kind, v.format, v.flags)) {
      prev = out[step.stage] = expectedInputHash(v, step.stage, prev);
    }
    return out;
  };

  it("stage_inputs_chain_so_changing_the_script_reruns_every_later_stage", () => {
    const a = chainHashes(view("script-1"));
    const b = chainHashes(view("script-2"));
    expect(Object.keys(a)).toEqual(["draft", "build", "generate", "tts", "render", "voice", "sfx", "qa"]);
    expect(b.draft).toBe(a.draft); // Draft does not read the script, it makes it
    for (const s of ["build", "generate", "tts", "render", "voice", "sfx", "qa"]) expect(b[s], s).not.toBe(a[s]);

    // Walk it the way the pipeline does: everything succeeded on script-1; with script-2 the first action is Build, and once
    // Build has a new hash every later stage is stale too, even though none of THEIR own content inputs changed.
    const runs = Object.fromEntries(Object.entries(a).map(([s, h]) => [s, { status: "succeeded" as const, inputHash: h }]));
    const done = { ...view("script-1"), runs, approved: new Set(["script", "cost", "video", "evidence", "publish"] as const) };
    expect(nextActions(done)).toEqual([{ kind: "done" }]);
    expect(nextActions({ ...done, content: { ...done.content, script: "script-2" } })).toMatchObject([{ kind: "enqueue", stage: "build" }]);
    const rebuilt = { ...done, content: { ...done.content, script: "script-2" }, runs: { ...runs, build: { status: "succeeded" as const, inputHash: b.build! } } };
    expect(nextActions(rebuilt)).toMatchObject([{ kind: "enqueue", stage: "generate", inputHash: b.generate }]);
  });

  it("imported_projects_skip_authoring_stages", () => {
    // Placeholder flag until Phase 9: the script exists already, so no Draft, no Build and no script gate.
    const plan = stagePlan("scene_kit", "short", { ...flags, imported: true });
    expect(plan.map((s) => s.stage)).toEqual(["generate", "tts", "render", "voice", "sfx", "qa"]);
    expect(plan.some((s) => s.gateAfter === "script")).toBe(false);
    const v: PipelineView = { ...view("s"), flags: { ...flags, imported: true }, approved: new Set() };
    expect(nextActions(v)).toEqual([{ kind: "wait_gate", gate: "cost" }]); // the first thing an imported project waits for is the cost gate
    expect(nextActions({ ...v, flags: { requireEvidence: true, paidGeneration: false, imported: true } })).toMatchObject([{ kind: "enqueue", stage: "tts" }]);
    expect(stagePlan("scene_kit", "short", flags)[0]?.stage).toBe("draft"); // default plans are unchanged
  });
});
