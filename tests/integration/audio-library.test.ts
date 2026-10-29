import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AudioRefused, addAudioItem, findLibraryFirst, markUsed, type NewAudioItem } from "@/server/db/audio-library";
import { importAudioLibrary } from "@/server/render/audio-import";
import { runChild } from "@/server/render/child";
import { withTestDb, type TestDb } from "../support/db";
import { assertFfprobeAvailable } from "../support/tools";

let db: TestDb;
let root: string;
const SHA = (c: string) => c.repeat(64);
const item = (o: Partial<NewAudioItem> = {}): NewAudioItem => ({
  kind: "sfx", name: "a", tags: ["x"], source: "owned", licence: "own", provenance: { by: "test" }, filePath: "f.mp3", sha256: SHA("a"),
  durationS: 1, meanLufs: -20, peakDbfs: -3, ...o,
});

beforeAll(async () => {
  assertFfprobeAvailable();
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "audiolib-")));
  db = await withTestDb();
});
afterAll(async () => {
  rmSync(root, { recursive: true, force: true });
  await db?.stop();
});
beforeEach(() => db.reset());

describe("audio library", () => {
  it("unlicensed_item_refused", async () => {
    await expect(addAudioItem(db.pool, item({ licence: "  " }))).rejects.toBeInstanceOf(AudioRefused);
    const { rows } = await db.pool.query("select count(*)::int n from audio_items");
    expect(rows[0].n).toBe(0);
  });
  it("duplicate_sha256_returns_existing_item", async () => {
    const a = await addAudioItem(db.pool, item());
    const b = await addAudioItem(db.pool, item({ name: "other" }));
    expect(b.id).toBe(a.id);
    expect(b.name).toBe("a");
  });
  it("library_first_prefers_tag_overlap_then_least_used", async () => {
    const one = await addAudioItem(db.pool, item({ name: "one", tags: ["a"], sha256: SHA("1") }));
    const two = await addAudioItem(db.pool, item({ name: "two", tags: ["a", "b"], sha256: SHA("2") }));
    const used = await addAudioItem(db.pool, item({ name: "used", tags: ["a"], sha256: SHA("3") }));
    await addAudioItem(db.pool, item({ name: "none", tags: ["z"], sha256: SHA("4") }));
    await addAudioItem(db.pool, item({ name: "music", kind: "music", tags: ["a", "b"], sha256: SHA("5") }));
    await addAudioItem(db.pool, item({ name: "long", tags: ["a", "b"], durationS: 30, sha256: SHA("6") }));
    await markUsed(db.pool, used.id, "v1");
    const r = await findLibraryFirst(db.pool, { kind: "sfx", tags: ["a", "b"], maxDurationS: 5 });
    expect(r.map((i) => i.id)).toEqual([two.id, one.id, used.id]);
  });
  it("markUsed_is_idempotent", async () => {
    const a = await addAudioItem(db.pool, item());
    await markUsed(db.pool, a.id, "v1");
    await markUsed(db.pool, a.id, "v1");
    await markUsed(db.pool, a.id, "v2");
    const { rows } = await db.pool.query("select used_in from audio_items where id = $1", [a.id]);
    expect(rows[0].used_in).toEqual(["v1", "v2"]);
  });
  it("import_script_rejects_files_without_catalog_entry", async () => {
    const dir = path.join(root, "lib");
    cpSync(path.join(process.cwd(), "assets-builtin/audio"), dir, { recursive: true });
    writeFileSync(path.join(dir, "sfx/clips/rogue.mp3"), "x");
    await expect(importAudioLibrary(db.pool, dir, { runChild })).rejects.toThrow(/rogue\.mp3/);
    const { rows } = await db.pool.query("select count(*)::int n from audio_items");
    expect(rows[0].n).toBe(0);
  });
  it("import_measures_and_registers_one_clip", async () => {
    const dir = path.join(root, "one");
    execFileSync("mkdir", ["-p", `${dir}/sfx/clips`, `${dir}/music/clips`]);
    execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "sine=f=440:d=1", "-c:a", "libmp3lame", `${dir}/sfx/clips/t.mp3`]);
    writeFileSync(path.join(dir, "sfx/catalog.json"), JSON.stringify({ clips: [{ id: "t", file: "clips/t.mp3", category: "c", tags: ["tone"], source: "x" }] }));
    writeFileSync(path.join(dir, "music/catalog.json"), JSON.stringify({ clips: [] }));
    expect(await importAudioLibrary(db.pool, dir, { runChild })).toEqual({ added: 1, existing: 0 });
    expect(await importAudioLibrary(db.pool, dir, { runChild })).toEqual({ added: 0, existing: 1 });
    const { rows } = await db.pool.query("select * from audio_items");
    expect(rows[0]).toMatchObject({ source: "shipped", name: "t", file_path: "sfx/clips/t.mp3" });
    expect(Number(rows[0].duration_s)).toBeGreaterThan(0.9);
    expect(Number(rows[0].mean_lufs)).toBeLessThan(0);
    expect(Number(rows[0].peak_dbfs)).toBeLessThan(0);
  });
});
