import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { KnownFailure } from "@/server/core/paid-call";
import type { StageContext } from "@/server/core/stage-handler";
import { addAudioItem } from "@/server/db/audio-library";
import { knownFailure, throwsUnknown } from "@/server/providers/fake-base";
import { createFakeSound } from "@/server/providers/sound/fake";
import { ensureSound, type SoundDeps } from "@/server/providers/sound";
import { runChild, type ChildSpec } from "@/server/render/child";
import { withTestDb, type TestDb } from "../support/db";
import { assertFfprobeAvailable } from "../support/tools";

let db: TestDb;
let audioRoot: string;
let attempt: string;
const need = { kind: "sfx" as const, prompt: "a soft whoosh", tags: ["whoosh"], seconds: 2 };
const ctx = () => ({ attemptDir: attempt, signal: new AbortController().signal, claim: { stageRunId: "run1" } }) as unknown as StageContext;
const deps = (provider: SoundDeps["provider"], generateAllowed = true): SoundDeps => ({ db: db.pool, provider, runChild: (s: ChildSpec) => runChild(s), audioRoot, generateAllowed });
const count = async () => (await db.pool.query("select count(*)::int n from audio_items")).rows[0].n as number;

beforeAll(async () => {
  assertFfprobeAvailable();
  audioRoot = realpathSync(mkdtempSync(path.join(tmpdir(), "snd-root-")));
  attempt = realpathSync(mkdtempSync(path.join(tmpdir(), "snd-att-")));
  db = await withTestDb();
});
afterAll(async () => {
  rmSync(audioRoot, { recursive: true, force: true });
  rmSync(attempt, { recursive: true, force: true });
  await db?.stop();
});
beforeEach(() => db.reset());

const seed = (tags = ["whoosh"]) =>
  addAudioItem(db.pool, { kind: "sfx", name: "lib", tags, source: "shipped", licence: "own", provenance: {}, filePath: "sfx/clips/a.mp3", sha256: "a".repeat(64), durationS: 1, meanLufs: -20, peakDbfs: -3 });

describe("ensureSound", () => {
  it("library_hit_never_calls_the_provider", async () => {
    const lib = await seed();
    const p = createFakeSound();
    expect((await ensureSound(ctx(), deps(p), need)).id).toBe(lib.id);
    expect(p.totalCalls()).toBe(0);
  });
  it("miss_without_generate_permission_refuses_with_plain_message", async () => {
    const p = createFakeSound();
    const e = await ensureSound(ctx(), deps(p, false), need).catch((x) => x);
    expect(e).toBeInstanceOf(KnownFailure);
    expect(e.message).toMatch(/not allowed/);
    expect(p.totalCalls()).toBe(0);
    expect(await count()).toBe(0);
  });
  it("empty_tags_are_refused_not_generated", async () => {
    const p = createFakeSound();
    await expect(ensureSound(ctx(), deps(p), { ...need, tags: [] })).rejects.toBeInstanceOf(KnownFailure);
    expect(p.totalCalls()).toBe(0);
  });
  it("generated_clip_is_catalogued_with_provenance_and_loudness", async () => {
    const item = await ensureSound(ctx(), deps(createFakeSound()), need);
    expect(item).toMatchObject({ kind: "sfx", source: "generated", tags: ["whoosh"] });
    expect(item.licence).toMatch(/generated with ElevenLabs/);
    expect(item.provenance).toMatchObject({ provider: "fake_sfx", priceMicroUsd: 2000, quoted: false, normalised: { targetLufs: -20, ceilingDbfs: -1.5 } });
    expect(item.peakDbfs!).toBeLessThanOrEqual(-1.4);
    expect(item.meanLufs).toBeLessThan(-10);
    expect(readFileSync(path.join(audioRoot, item.filePath)).length).toBeGreaterThan(0);
    // second ask finds it in the library: no second generation
    const p = createFakeSound();
    expect((await ensureSound(ctx(), deps(p), need)).id).toBe(item.id);
    expect(p.totalCalls()).toBe(0);
  });
  it("unknown_outcome_parks", async () => {
    const e = await ensureSound(ctx(), deps(createFakeSound({ script: [throwsUnknown()] })), need).catch((x) => x);
    expect(e).not.toBeInstanceOf(KnownFailure);
    expect(await count()).toBe(0);
  });
  it("failed_generation_never_falls_back_to_a_library_track", async () => {
    // a music track exists but shares no tag: the owner may choose it, the code never does
    await addAudioItem(db.pool, { kind: "music", name: "bed", tags: ["calm"], source: "shipped", licence: "own", provenance: {}, filePath: "music/clips/b.mp3", sha256: "b".repeat(64), durationS: 60, meanLufs: -20, peakDbfs: -3 });
    const p = createFakeSound({ script: [knownFailure("rejected")] });
    const e = await ensureSound(ctx(), deps(p), { ...need, kind: "music", seconds: 30 }).catch((x) => x);
    expect(e).toBeInstanceOf(KnownFailure);
    expect(p.totalCalls()).toBe(1);
    expect(await count()).toBe(1);
  });
});
