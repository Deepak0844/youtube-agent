import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sha256Hex } from "@/server/core/content-hash";
import { uuidv7 } from "@/server/core/ids";
import { approveGate, liveGateHash } from "@/server/db/approvals";
import { createDerivedShort, loadDeriveTab } from "@/server/db/derive";
import { addContent, createVideoRow } from "@/server/db/videos";
import { withTestDb, type TestDb } from "../support/db";

// A short cut from a long video, end to end on a real database and a real ffmpeg: the long video has 6 scenes of 10 s (one beat each, ten words per beat),
// narrated by a 60 s tone. Build's stored scene timing is deliberately wrong (every scene 5 s) to prove the clip uses the real narration times.
let db: TestDb;
let root: string;
const SESSION = { kind: "session", sessionId: "11111111-1111-4111-8111-111111111111" } as const;
const queued: string[] = [];
const queue = { enqueue: async (id: string) => (queued.push(id), `job.${id}`) };

beforeAll(async () => {
  db = await withTestDb();
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "derive-")));
});
afterAll(async () => {
  rmSync(root, { recursive: true, force: true });
  await db?.stop();
});
beforeEach(async () => {
  await db.reset();
  queued.length = 0;
  await db.pool.query("insert into sessions (id, token_hash, expires_at, absolute_expires_at) values ($1, 'derive', clock_timestamp() + interval '1 day', clock_timestamp() + interval '7 days') on conflict (id) do nothing", [SESSION.sessionId]);
});

const BEATS = ["c1_b1", "c1_b2", "c2_b1", "c2_b2", "c3_b1", "c3_b2"];
const beatWords = (i: number) => Array.from({ length: 10 }, (_, k) => `b${i}w${k}`);

/** A narrated long video with an approved script. `scenes` = how many of the 6 scenes exist. */
async function longVideo(o: { scenes?: number; narrate?: boolean } = {}): Promise<string> {
  const v = await createVideoRow(db.pool, { format: "long", kind: "collage", language: "en", topic: "Why the sea is salty", lengthMinMinutes: 3, lengthMaxMinutes: 8, style: "ai_studio", captionStyle: null });
  const run = uuidv7();
  await addContent(db.pool, v.id, "script", { body: { title: "T", narration: BEATS.flatMap((_, i) => beatWords(i)).join(" ") }, sha256: sha256Hex("script"), producedBy: run });
  await addContent(db.pool, v.id, "beats", { body: { beats: BEATS.map((id, i) => ({ id, text: beatWords(i).join(" "), est_start: i * 5, est_end: i * 5 + 5 })) }, sha256: sha256Hex("beats"), producedBy: run });
  await addContent(db.pool, v.id, "evidence", { body: { claims: [{ text: "salt comes from rocks", kind: "computed", method: "m" }] }, sha256: sha256Hex("evidence"), producedBy: run });
  const n = o.scenes ?? 6;
  const doc = { version: 1, scenes: BEATS.slice(0, n).map((beat, i) => ({ id: `s${i + 1}`, kind: "terminal", beat, startMs: i * 5000, durationMs: 5000, lines: [{ text: `line ${i}` }] })) };
  await addContent(db.pool, v.id, "scenes", { body: doc, sha256: sha256Hex("scenes") });
  if (o.narrate !== false) {
    mkdirSync(path.join(root, "videos", v.id), { recursive: true });
    execFileSync("ffmpeg", ["-nostdin", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=60", "-ar", "22050", "-ac", "1", "-c:a", "pcm_s16le", path.join(root, "videos", v.id, "narration.wav")]);
    const words = BEATS.flatMap((_, i) => beatWords(i).map((word, k) => ({ word, startS: i * 10 + k, endS: i * 10 + k + 0.9, source: "recognised", flags: [] })));
    await addContent(db.pool, v.id, "narration", { body: { file: "narration.wav", word_timings: "aligned", lang: "en", provider: "fake" }, sha256: sha256Hex("narration") });
    await addContent(db.pool, v.id, "captions", { body: { words, needs_check: false }, sha256: sha256Hex("captions") });
  }
  const seen = (await liveGateHash(db.pool, v.id, "script"))!.hash;
  expect(await approveGate(db.pool, { videoId: v.id, gate: "script", seenHash: seen, actor: SESSION })).toMatchObject({ ok: true });
  return v.id;
}

describe("createDerivedShort", () => {
  it("is refused while clips from a long video are unavailable (they were made with the removed scene kit), and creates nothing", async () => {
    const src = await longVideo();
    const before = (await db.pool.query("select count(*)::int n from videos")).rows[0].n;
    expect(await createDerivedShort(db.pool, queue, { sourceId: src, fromScene: 0, toScene: 1 })).toMatchObject({ ok: false, message: expect.stringMatching(/not available/) });
    expect((await db.pool.query("select count(*)::int n from videos")).rows[0].n).toBe(before);
  });
});

describe("loadDeriveTab (the Shorts panel)", () => {
  const approveOutline = async (videoId: string) => {
    const chapter = (title: string) => ({ title, line: `about ${title}`, target_s: 100 });
    await addContent(db.pool, videoId, "outline", { body: { chapters: [chapter("Hook"), chapter("How it works"), chapter("Why it matters")], length: { min_minutes: 3, max_minutes: 8 } }, sha256: sha256Hex("outline") });
    const seen = (await liveGateHash(db.pool, videoId, "outline"))!.hash;
    expect(await approveGate(db.pool, { videoId, gate: "outline", seenHash: seen, actor: SESSION })).toMatchObject({ ok: true });
  };

  it("lists the scenes at their REAL times (not Build's rough ones) and each chapter as a clip with 1-based scene numbers", async () => {
    const src = await longVideo();
    await approveOutline(src);
    const tab = await loadDeriveTab(db.pool, src);
    expect(tab.notReady).toBeNull();
    expect(tab.bounds).toEqual([[0, 10_000], [10_000, 20_000], [20_000, 30_000], [30_000, 40_000], [40_000, 50_000], [50_000, 60_600]]); // the last scene runs 0.4 s past the last spoken word (the video does not cut off mid-sentence); the panel takes the narration as the last word + 0.3 s
    expect(tab.chapters.map((c) => [c.n, c.title, c.firstScene, c.lastScene, c.lengthMs, c.problem])).toEqual([
      [1, "Hook", 1, 2, 20_000, null], [2, "How it works", 3, 4, 20_000, null], [3, "Why it matters", 5, 6, 20_600, null],
    ]);
  });
  it("says why it cannot offer scenes yet: script not approved, no scenes, not narrated", async () => {
    const draft = await createVideoRow(db.pool, { format: "long", kind: "collage", language: "en", topic: "t", lengthMinMinutes: 3, lengthMaxMinutes: 8 });
    expect((await loadDeriveTab(db.pool, draft.id)).notReady).toMatch(/Approve this video's script first/);
    expect((await loadDeriveTab(db.pool, await longVideo({ narrate: false }))).notReady).toMatch(/no narration times yet/);
    const tab = await loadDeriveTab(db.pool, await longVideo());
    expect(tab.notReady).toBeNull();
    expect(tab.chapters).toEqual([]); // no approved outline: the custom scene range still works
    expect(tab.bounds).toHaveLength(6);
  });
});
