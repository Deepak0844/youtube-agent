import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { canonicalJson, sha256Hex } from "@/server/core/content-hash";
import { buildEngineConfig } from "@/server/core/engine-config";
import { uuidv7 } from "@/server/core/ids";
import { parseCostPlan } from "@/server/core/cost-plan";
import type { StageHandler } from "@/server/core/stage-handler";
import type { StageOutcome } from "@/server/core/stage-runner";
import { approveGate, liveGateHash } from "@/server/db/approvals";
import { runStage } from "@/server/db/stage-runner-adapter";
import { insertQueuedStage } from "@/server/db/stages";
import { addContent, createVideoRow, latestContent } from "@/server/db/videos";
import { createFakeImage } from "@/server/providers/media/fake";
import { createFakeRenderer } from "@/server/providers/renderer/fake";
import { createFakeVideo } from "@/server/providers/video/fake";
import { createFakeVoice } from "@/server/providers/voice/fake";
import { withAttempt } from "@/worker/stages/attempt";
import { buildAttempt } from "@/worker/stages/build";
import type { StageDeps } from "@/worker/stages/deps";
import { shotsAttempt } from "@/worker/stages/shots";
import { withTestDb, type TestDb } from "../support/db";

// The AI route's shot plan on a fake video provider: it prices every clip, writes the cost plan the owner approves, and moves no money.
let db: TestDb;
let root: string;
const config = buildEngineConfig(new Map());
const SESSION = { kind: "session", sessionId: "11111111-1111-4111-8111-111111111111" } as const;
const noProvider = { call: async () => Promise.reject(new Error("no provider in handler mode")) };

beforeAll(async () => {
  db = await withTestDb();
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "ai-shots-")));
});
afterAll(async () => {
  rmSync(root, { recursive: true, force: true });
  await db?.stop();
});
beforeEach(async () => {
  await db.reset();
  await db.pool.query("insert into budgets (scope, cap_micro_usd) values ('video:ai', 5000000), ('day', 15000000), ('month', 100000000)");
  await db.ownerPool.query("insert into media_routes (kind, scope, provider, model) values ('video', 'kind:ai', 'fake-video', 'fake-video') on conflict (kind, scope) do update set provider = excluded.provider, model = excluded.model");
});

const deps = (over: Partial<StageDeps> = {}): StageDeps => {
  const voice = createFakeVoice();
  const fake = createFakeVideo();
  return { db: db.pool, root, voiceFor: async (a: { budgetScopes: string[] }) => ({ provider: voice.forScopes(a.budgetScopes), providerId: "fake", voice: "fake" }), image: createFakeImage(), renderer: createFakeRenderer(), videoFor: async () => fake, ...over };
};
const shots = (over: Partial<StageDeps> = {}) => withAttempt({ db: db.pool, root }, shotsAttempt(deps(over)));
async function play(videoId: string, name: string, handler: StageHandler): Promise<StageOutcome> {
  const inputHash = `h-${name}-${uuidv7()}`;
  const stageRunId = await insertQueuedStage(db.pool, { videoId, name, inputHash });
  return runStage(db.pool, { provider: noProvider, ttlMs: 60_000, workerId: "w1", handler, config }, { stageRunId, inputHash });
}
const stageRow = async (id: string, name: string) => (await db.pool.query("select status, result from stage_runs where video_id = $1 and name = $2 order by created_at desc limit 1", [id, name])).rows[0] as { status: string; result: Record<string, unknown> | null };
const spent = async () => Number((await db.pool.query("select coalesce(sum(amount_micro_usd), 0)::text as n from spend_ledger").catch(() => ({ rows: [{ n: "0" }] }))).rows[0].n);

const BEATS = [
  { id: "b1", text: "one two three four five six", visual: "A red fox runs through deep snow." },
  { id: "b2", text: "seven eight nine ten", visual: "The fox stops at a frozen river." },
];
// Words one second apart: beat b1 has 6 words (6 s), beat b2 has 4 (3.8 s, to the end of the last word).
const words = Array.from({ length: 10 }, (_, i) => ({ word: `w${i}`, startS: i, endS: i + 0.8, source: "estimated", flags: [] }));

async function aiVideo(over: { beats?: Array<Record<string, unknown>>; captions?: boolean } = {}): Promise<string> {
  const v = await createVideoRow(db.pool, { format: "short", kind: "ai", language: "en", topic: "A fox crosses a frozen river" });
  const script = { title: "Fox", narration: BEATS.map((b) => b.text).join(" ") };
  await addContent(db.pool, v.id, "script", { body: script, sha256: sha256Hex(canonicalJson(script)) });
  const beats = { beats: over.beats ?? BEATS };
  await addContent(db.pool, v.id, "beats", { body: beats, sha256: sha256Hex(canonicalJson(beats)) });
  if (over.captions !== false) {
    const caps = { timings_kind: "estimated", words, needs_check: true, flags: [], approximate: true };
    await addContent(db.pool, v.id, "captions", { body: caps, sha256: sha256Hex(canonicalJson(caps)) });
  }
  const live = await liveGateHash(db.pool, v.id, "script");
  const ok = await approveGate(db.pool, { videoId: v.id, gate: "script", seenHash: live!.hash, actor: SESSION });
  if (!ok.ok) throw new Error(ok.reason);
  return v.id;
}

describe("the shot plan stage", () => {
  it("writes one priced clip per beat, as long as its narration, and spends nothing", async () => {
    const id = await aiVideo();
    const out = await play(id, "shots", shots());
    expect(out.kind).toBe("committed");
    const plan = await latestContent(db.pool, id, "cost_plan");
    const body = plan!.body as { items: unknown[]; shots: Array<{ beatId: string; seconds: number; prompt: string }>; path: string; totalMicroUsd: number };
    expect(body.path).toBe("ai");
    expect(body.shots.map((s) => [s.beatId, s.seconds])).toEqual([["b1", 6], ["b2", 4]]); // 6 s, and 3.8 s rounded up
    expect(body.shots[0]!.prompt).toMatch(/^A red fox runs through deep snow\. No text, captions, logos or watermarks\.$/);
    expect(body.items).toEqual([
      { kind: "clip", provider: "fake-video/fake-video", quoteMicroUsd: 600_000 },
      { kind: "clip", provider: "fake-video/fake-video", quoteMicroUsd: 400_000 },
    ]);
    expect(body.totalMicroUsd).toBe(1_000_000);
    const parsed = parseCostPlan(plan!.body);
    expect(parsed.ok).toBe(true);
    expect(await spent()).toBe(0);
  });

  it("refuses with a plain sentence, writes no plan and spends nothing: no route model, no provider wiring, unpriced model, missing visual, no narration times, plan over the cap", async () => {
    const id = await aiVideo();
    const parks = async (over: Partial<StageDeps>, text: RegExp) => {
      const out = await play(id, "shots", shots(over));
      expect(out.kind).not.toBe("succeeded");
      expect(JSON.stringify(await stageRow(id, "shots"))).toMatch(text);
      expect(await latestContent(db.pool, id, "cost_plan")).toBeNull();
    };
    await parks({ videoFor: undefined }, /not set up in this app/);
    await parks({ videoFor: async () => createFakeVideo({ price: null }) }, /no per-second price/);
    await db.ownerPool.query("update media_routes set model = null where kind = 'video'");
    await parks({}, /Pick an AI video provider and model/);
    await db.ownerPool.query("update media_routes set model = 'not-a-model' where kind = 'video'");
    await parks({}, /not one this provider offers/);
    expect(await spent()).toBe(0);
  });

  it("names the beat that has no visual sentence", async () => {
    const id = await aiVideo({ beats: [BEATS[0]!, { id: "b2", text: BEATS[1]!.text }] });
    const out = await play(id, "shots", shots());
    expect(out.kind).not.toBe("succeeded");
    expect(JSON.stringify(await stageRow(id, "shots"))).toMatch(/Beat b2 has no visual sentence/);
  });

  it("stops when the narration does not line up with the beats, or does not exist yet", async () => {
    const a = await aiVideo({ captions: false });
    expect((await play(a, "shots", shots())).kind).not.toBe("succeeded");
    expect(JSON.stringify(await stageRow(a, "shots"))).toMatch(/do not line up/);
    const b = await aiVideo({ beats: [{ id: "b1", text: "only three words", visual: "A fox." }] });
    expect((await play(b, "shots", shots())).kind).not.toBe("succeeded");
  });

  it("refuses to plan a plan that would not fit under the caps, and names the cap", async () => {
    await db.pool.query("update budgets set cap_micro_usd = 100000 where scope = 'video:ai'");
    const id = await aiVideo();
    const out = await play(id, "shots", shots());
    expect(out.kind).not.toBe("succeeded");
    expect(JSON.stringify(await stageRow(id, "shots"))).toMatch(/plan_over_the_cap/);
    expect(await latestContent(db.pool, id, "cost_plan")).toBeNull();
  });

  it("only an AI video has a shot plan", async () => {
    const v = await createVideoRow(db.pool, { format: "short", kind: "scene_kit", language: "en", topic: "t" });
    const out = await play(v.id, "shots", shots());
    expect(out.kind).not.toBe("succeeded");
    expect(JSON.stringify(await stageRow(v.id, "shots"))).toMatch(/Only an AI video/);
  });
});

describe("Build for an AI video", () => {
  it("never writes a cost plan, so the approved clip plan is not replaced", async () => {
    const id = await aiVideo();
    await play(id, "shots", shots());
    const before = await latestContent(db.pool, id, "cost_plan");
    const out = await play(id, "build", withAttempt({ db: db.pool, root }, buildAttempt(deps())));
    expect(out.kind).toBe("committed");
    const after = await latestContent(db.pool, id, "cost_plan");
    expect(after!.version).toBe(before!.version);
    expect((after!.body as { path: string }).path).toBe("ai");
  });
});
