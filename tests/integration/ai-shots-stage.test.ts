import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync } from "node:fs";
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
import { createHash } from "node:crypto";
import { KnownFailure } from "@/server/core/paid-call";
import { createFakeVideo } from "@/server/providers/video/fake";
import { assetsForVideo } from "@/server/db/video-assets";
import { CharacterRefused, characterOf, setVideoCharacter } from "@/server/db/video-characters";
import { registerAsset } from "@/server/db/assets";
import { RIGHTS_TEXT } from "@/server/core/asset-rules";
import type { ClipArgs, VideoProvider } from "@/server/providers/video";
import { generateClipsAttempt } from "@/worker/stages/generate-clips";
import { knownFailure, throwsUnknown } from "@/server/providers/fake-base";
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
  await db.ownerPool.query("insert into media_routes (kind, scope, provider, model) values ('video', 'kind:ai', 'fake_video', 'fake-video') on conflict (kind, scope) do update set provider = excluded.provider, model = excluded.model");
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
      { kind: "clip", provider: "fake_video/fake-video", quoteMicroUsd: 600_000 },
      { kind: "clip", provider: "fake_video/fake-video", quoteMicroUsd: 400_000 },
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

// ---- Generate for an AI video ------------------------------------------------------------------------------------------------------------

const okClip = (name?: string) => async (_d: unknown, a: { srcPath: string; destDir: string }) => {
  mkdirSync(a.destDir, { recursive: true });
  renameSync(a.srcPath, path.join(a.destDir, "main.mp4"));
  return { ok: true as const, kind: "video" as const, mime: "video/mp4", width: 1080, height: 1920, durationS: 6, bytes: 16, originalBytes: 16, sha256: createHash("sha256").update(name ?? `clip-${Math.random()}`).digest("hex"), files: { main: path.join(a.destDir, "main.mp4") } };
};
const gen = (over: Partial<StageDeps> = {}) => withAttempt({ db: db.pool, root }, generateClipsAttempt(deps({ ingest: { runChild: async () => { throw new Error("not used"); } }, ingestClipFn: okClip() as never, ...over })));
async function approvedPlan(): Promise<string> {
  const id = await aiVideo();
  expect((await play(id, "shots", shots())).kind).toBe("committed");
  const live = await liveGateHash(db.pool, id, "cost");
  const ok = await approveGate(db.pool, { videoId: id, gate: "cost", seenHash: live!.hash, actor: SESSION });
  if (!ok.ok) throw new Error(ok.reason);
  return id;
}
const intents = async () => Number((await db.pool.query("select coalesce(sum(coalesce(actual_micro_usd, 0)), 0)::text n from spend_intents")).rows[0].n);

describe("the clip generation stage", () => {
  it("buys each approved clip once, saves it as an AI-made library clip linked to its beat, and records the clips", async () => {
    const id = await approvedPlan();
    const fake = createFakeVideo();
    const out = await play(id, "generate", gen({ videoFor: async () => fake }));
    expect(out.kind).toBe("committed");
    expect(fake.totalCalls()).toBe(2);
    const links = await assetsForVideo(db.pool, id);
    expect(links.map((l) => [l.beatId, l.kind]).sort()).toEqual([["b1", "video"], ["b2", "video"]]);
    expect(links.every((l) => l.briefHash?.startsWith("ai:"))).toBe(true);
    const rows = (await db.pool.query("select source, kind, tags, rights from assets order by created_at")).rows as Array<{ source: string; kind: string; tags: string[]; rights: { attestations: Array<{ text: string; by: string }> } }>;
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(r).toMatchObject({ source: "generated", kind: "video" });
      expect(r.tags).toContain("ai");
      expect(r.rights.attestations[0]).toMatchObject({ by: "system", text: expect.stringMatching(/^Generated by AI for this video with/) });
    }
    const clips = await latestContent(db.pool, id, "clips");
    expect((clips!.body as { items: Array<{ beatId: string; seconds: number }> }).items.map((i) => [i.beatId, i.seconds])).toEqual([["b1", 6], ["b2", 4]]);
    expect(await intents()).toBe(1_000_000); // exactly the approved total
  });

  it("buys nothing when the plan is not approved, when it changed after approval, when another model is routed, or when a price moved", async () => {
    const id = await aiVideo();
    await play(id, "shots", shots());
    const fake = createFakeVideo();
    const refused = async (over: Partial<StageDeps>, why: RegExp) => {
      const out = await play(id, "generate", gen({ videoFor: async () => fake, ...over }));
      expect(out.kind).not.toBe("committed");
      expect(JSON.stringify(await stageRow(id, "generate"))).toMatch(why);
      expect(fake.totalCalls()).toBe(0);
    };
    await refused({}, /not approved/); // the cost gate was never approved
    const live = await liveGateHash(db.pool, id, "cost");
    await approveGate(db.pool, { videoId: id, gate: "cost", seenHash: live!.hash, actor: SESSION });
    await refused({ videoFor: async () => createFakeVideo({ price: { unit: "per_second", microUsd: 999_999 } }) }, /price changed/);
    await db.ownerPool.query("update media_routes set model = 'fake-text-only' where kind = 'video'");
    await refused({}, /different video model/);
    await db.ownerPool.query("update media_routes set model = 'fake-video' where kind = 'video'");
    const body = (await latestContent(db.pool, id, "cost_plan"))!.body as Record<string, unknown>;
    const edited = { ...body, shots: [] };
    await addContent(db.pool, id, "cost_plan", { body: edited, sha256: sha256Hex(canonicalJson(edited)) });
    await refused({}, /not approved|changed/);
    expect(await intents()).toBe(0);
    expect(await assetsForVideo(db.pool, id)).toHaveLength(0);
  });

  it("a provider that charges more than it quoted stops the run before the next clip", async () => {
    const id = await approvedPlan();
    const fake = createFakeVideo({ priceMicroUsd: 1_200_000 });
    const out = await play(id, "generate", gen({ videoFor: async () => fake }));
    expect(out.kind).not.toBe("committed");
    expect(fake.totalCalls()).toBe(1);
  });

  it("a clip that fails the safety check after it was paid for parks as an unknown outcome and is never bought again", async () => {
    const id = await approvedPlan();
    const fake = createFakeVideo();
    const bad = (async () => ({ ok: false, reason: "bad_clip" })) as never;
    const err = await play(id, "generate", gen({ videoFor: async () => fake, ingestClipFn: bad })).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(Error); // a plain error (never a refusal): the runner parks the stage for the owner and keeps the money held
    expect(err).not.toBeInstanceOf(KnownFailure);
    expect(String((err as Error).message)).toMatch(/safety check/);
    expect(fake.totalCalls()).toBe(1);
    expect(await assetsForVideo(db.pool, id)).toHaveLength(0);
  });

  it("a refused or unknown provider answer stops the run with nothing linked", async () => {
    for (const script of [[knownFailure("no")], [throwsUnknown()]]) {
      await db.reset();
      await db.pool.query("insert into budgets (scope, cap_micro_usd) values ('video:ai', 5000000), ('day', 15000000), ('month', 100000000)");
      await db.ownerPool.query("insert into media_routes (kind, scope, provider, model) values ('video', 'kind:ai', 'fake_video', 'fake-video')");
      const id = await approvedPlan();
      const out = await play(id, "generate", gen({ videoFor: async () => createFakeVideo({ script }) })).catch(() => ({ kind: "threw" }));
      expect(out.kind).not.toBe("committed");
      expect(await assetsForVideo(db.pool, id)).toHaveLength(0);
    }
  });

  it("is only for AI videos, and needs the clip check to be set up", async () => {
    const v = await createVideoRow(db.pool, { format: "short", kind: "scene_kit", language: "en", topic: "t" });
    expect((await play(v.id, "generate", gen())).kind).not.toBe("committed");
    expect(JSON.stringify(await stageRow(v.id, "generate"))).toMatch(/Only an AI video/);
    const id = await approvedPlan();
    expect((await play(id, "generate", gen({ ingest: undefined }))).kind).not.toBe("committed");
    expect(JSON.stringify(await stageRow(id, "generate"))).toMatch(/Clip checking is not set up/);
  });
});

// ---- Locked character -------------------------------------------------------------------------------------------------------------------

async function pictureAsset(over: Partial<{ mime: string; width: number; height: number; sha: string }> = {}): Promise<string> {
  const r = await registerAsset(db.pool, {
    kind: "image", originalName: "hero.png", mime: over.mime ?? "image/png", bytes: 10, width: over.width ?? 1024, height: over.height ?? 1536, sha256: createHash("sha256").update(over.sha ?? `hero-${Math.random()}`).digest("hex"),
    storageRef: "assets/hero/main.png", tags: [], source: "upload", rights: { attestations: [{ at: new Date().toISOString(), text: RIGHTS_TEXT }] },
  } as never);
  return r.asset.id;
}
/** Records the arguments every quote and generate call gets. */
function spy(inner: VideoProvider): VideoProvider & { quoted: ClipArgs[]; made: ClipArgs[] } {
  const quoted: ClipArgs[] = [];
  const made: ClipArgs[] = [];
  return { capability: inner.capability, quoted, made, quote: (a) => (quoted.push(a), inner.quote(a)), generate: (ctx, a) => (made.push(a), inner.generate(ctx, a)) };
}

describe("a locked character", () => {
  it("only an AI video has one, only a valid picture can be one, and the choice is audited and read back", async () => {
    const sk = await createVideoRow(db.pool, { format: "short", kind: "scene_kit", language: "en", topic: "t" });
    const ai = await aiVideo();
    const pic = await pictureAsset();
    await expect(setVideoCharacter(db.pool, sk.id, pic)).rejects.toThrow(/Only an AI video/);
    await expect(setVideoCharacter(db.pool, ai, await pictureAsset({ mime: "image/webp" }))).rejects.toBeInstanceOf(CharacterRefused);
    await expect(setVideoCharacter(db.pool, ai, await pictureAsset({ width: 100 }))).rejects.toThrow(/at least 300/);
    await expect(setVideoCharacter(db.pool, ai, "00000000-0000-4000-8000-000000000000")).rejects.toThrow(/does not exist/);
    expect(await characterOf(db.pool, ai)).toBeNull();
    await setVideoCharacter(db.pool, ai, pic);
    expect(await characterOf(db.pool, ai)).toEqual({ assetId: pic, storageRef: "assets/hero/main.png" });
    expect((await db.ownerPool.query("select detail from audit_log where event = 'video.character_set'")).rows).toHaveLength(1);
    await db.ownerPool.query("update assets set deleted_at = now() where id = $1", [pic]);
    expect(await characterOf(db.pool, ai)).toBeNull(); // a deleted picture is no character
    await setVideoCharacter(db.pool, ai, null);
    expect(await characterOf(db.pool, ai)).toBeNull();
  });

  it("every clip is quoted and bought with the character as its start picture, and the plan records which picture", async () => {
    const id = await aiVideo();
    const pic = await pictureAsset();
    await setVideoCharacter(db.pool, id, pic);
    const fake = spy(createFakeVideo());
    expect((await play(id, "shots", shots({ videoFor: async () => fake }))).kind).toBe("committed");
    expect(fake.quoted.length).toBeGreaterThan(0);
    for (const q of fake.quoted) expect(q).toMatchObject({ startImage: true, startImagePath: "assets/hero/main.png" });
    expect(((await latestContent(db.pool, id, "cost_plan"))!.body as { character: unknown }).character).toEqual({ assetId: pic, storageRef: "assets/hero/main.png" });
    const live = await liveGateHash(db.pool, id, "cost");
    await approveGate(db.pool, { videoId: id, gate: "cost", seenHash: live!.hash, actor: SESSION });
    expect((await play(id, "generate", gen({ videoFor: async () => fake }))).kind).toBe("committed");
    expect(fake.made).toHaveLength(2);
    for (const m of fake.made) expect(m).toMatchObject({ startImage: true, startImagePath: "assets/hero/main.png" });
  });

  it("a model that cannot start from a picture is refused for a character, with nothing planned or bought", async () => {
    const id = await aiVideo();
    await setVideoCharacter(db.pool, id, await pictureAsset());
    await db.ownerPool.query("update media_routes set model = 'fake-text-only' where kind = 'video'");
    const out = await play(id, "shots", shots());
    expect(out.kind).not.toBe("committed");
    expect(JSON.stringify(await stageRow(id, "shots"))).toMatch(/cannot start from a picture|keep a character/);
    expect(await latestContent(db.pool, id, "cost_plan")).toBeNull();
  });

  it("changing or removing the character after approval buys nothing", async () => {
    const id = await aiVideo();
    const pic = await pictureAsset();
    await setVideoCharacter(db.pool, id, pic);
    await play(id, "shots", shots());
    const live = await liveGateHash(db.pool, id, "cost");
    await approveGate(db.pool, { videoId: id, gate: "cost", seenHash: live!.hash, actor: SESSION });
    const fake = createFakeVideo();
    for (const change of [() => setVideoCharacter(db.pool, id, null), async () => setVideoCharacter(db.pool, id, await pictureAsset())]) {
      await change();
      const out = await play(id, "generate", gen({ videoFor: async () => fake }));
      expect(out.kind).not.toBe("committed");
      expect(JSON.stringify(await stageRow(id, "generate"))).toMatch(/character picture changed/);
    }
    expect(fake.totalCalls()).toBe(0);
  });
});
