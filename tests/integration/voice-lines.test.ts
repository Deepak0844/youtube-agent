import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { lineCacheKey, splitLines } from "@/server/core/voice-lines";
import { lookupLine, placeLineFile, storeLine, touchLine, type VoiceLineRow } from "@/server/db/voice-lines";
import { createFakeVoice } from "@/server/providers/voice/fake";
import type { StageContext } from "@/server/core/stage-handler";
import { withTestDb, type TestDb } from "../support/db";

let db: TestDb;
let root: string;
beforeAll(async () => {
  db = await withTestDb();
  root = mkdtempSync(path.join(tmpdir(), "voice-lines-"));
});
beforeEach(() => db.reset());
afterAll(async () => {
  await db?.stop();
  rmSync(root, { recursive: true, force: true });
});

const ctx = (): StageContext => {
  const dir = path.join(root, "attempt");
  mkdirSync(dir, { recursive: true });
  return { claim: { stageRunId: "s1" }, attemptDir: dir, signal: new AbortController().signal } as unknown as StageContext;
};
const settings = { speed: 1 };

/** The cache flow Task 10 will use: look up, else synthesise, place the file, then store the row. */
async function narrate(voice: ReturnType<typeof createFakeVoice>, text: string) {
  const out: string[] = [];
  for (const line of splitLines(text, "en")) {
    const key = lineCacheKey({ text: line.text, voice: "v", model: "m", lang: "en", settings });
    const hit = await lookupLine(db.pool, key);
    if (hit) {
      await touchLine(db.pool, key);
      out.push(hit.filePath);
      continue;
    }
    const r = await voice.synthesise(ctx(), { text: line.text, lang: "en", voice: "v", model: "m", settings });
    const bytes = await readFile(r.audioPath);
    const filePath = await placeLineFile(root, key, "wav", r.audioPath);
    await storeLine(db.pool, root, { cacheKey: key, provider: "fake", bytes: bytes.length, sha256: sha(bytes), durationS: 1, wordTimings: r.wordTimings, timingsKind: r.timingsKind, filePath, priceMicroUsd: r.priceMicroUsd });
    out.push(filePath);
  }
  return out;
}

const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const row = (cacheKey: string, filePath: string, bytes: number, content = "abc"): VoiceLineRow => ({ cacheKey, provider: "fake", bytes, sha256: sha(content), durationS: 1.5, wordTimings: null, timingsKind: "none", filePath, priceMicroUsd: 7 });
const KEY = "ab".repeat(32);

describe("voice line cache", () => {
  it("unchanged_line_is_a_cache_hit_and_only_changed_line_misses", async () => {
    const voice = createFakeVoice();
    const first = await narrate(voice, "One fine line. Two fine lines. Three fine lines.");
    expect(voice.totalCalls()).toBe(3);
    expect(await narrate(voice, "One fine line. Two fine lines. Three fine lines.")).toEqual(first);
    expect(voice.totalCalls()).toBe(3);
    const third = await narrate(voice, "One fine line. Two rewritten lines. Three fine lines.");
    expect(voice.totalCalls()).toBe(4);
    expect(third[0]).toBe(first[0]);
    expect(third[1]).not.toBe(first[1]);
    expect(third[2]).toBe(first[2]);
    expect(first[0]).toMatch(/^voice-cache\/[0-9a-f]{2}\/[0-9a-f]{64}\.wav$/);
    expect((await db.pool.query("select 1 from voice_lines")).rowCount).toBe(4);
  });

  it("cache_row_written_only_after_file_exists", async () => {
    const rel = `voice-cache/ab/${KEY}.wav`;
    await expect(storeLine(db.pool, root, row(KEY, rel, 3))).rejects.toThrow("not on disk");
    expect(await lookupLine(db.pool, KEY)).toBeNull();
    mkdirSync(path.join(root, "voice-cache/ab"), { recursive: true });
    writeFileSync(path.join(root, rel), "abc");
    await expect(storeLine(db.pool, root, row(KEY, rel, 4))).rejects.toThrow("not on disk"); // wrong size
    expect((await storeLine(db.pool, root, row(KEY, rel, 3))).created).toBe(true);
    expect(await lookupLine(db.pool, KEY)).toMatchObject({ provider: "fake", bytes: 3, durationS: 1.5, priceMicroUsd: 7, timingsKind: "none", wordTimings: null });
    await expect(storeLine(db.pool, root, row(KEY, "../escape.wav", 3))).rejects.toThrow();
    expect(existsSync(path.join(root, rel))).toBe(true);
  });

  it("two_concurrent_misses_for_the_same_key_store_one_row", async () => {
    const k = "cd".repeat(32);
    const rs = await Promise.all(
      ["aaa", "bbbb"].map(async (content, i) => {
        const src = path.join(root, `src${i}.wav`);
        writeFileSync(src, content);
        return storeLine(db.pool, root, row(k, await placeLineFile(root, k, "wav", src), content.length, content));
      }),
    );
    expect(rs.filter((r) => r.created)).toHaveLength(1);
    expect(rs[0]!.row).toEqual(rs[1]!.row);
    const stored = (await db.pool.query<{ sha256: string; file_path: string }>("select sha256, file_path from voice_lines")).rows;
    expect(stored).toHaveLength(1);
    expect(sha(await readFile(path.join(root, stored[0]!.file_path)))).toBe(stored[0]!.sha256);
  });

  it("app_role_may_only_touch_last_used_at", async () => {
    const rel = `voice-cache/ab/${KEY}.wav`;
    mkdirSync(path.join(root, "voice-cache/ab"), { recursive: true });
    writeFileSync(path.join(root, rel), "abc");
    await storeLine(db.pool, root, row(KEY, rel, 3));
    await expect(db.pool.query("update voice_lines set file_path = 'x'")).rejects.toMatchObject({ code: "42501" });
    await expect(db.pool.query("update voice_lines set price_micro_usd = 0")).rejects.toMatchObject({ code: "42501" });
    await expect(db.pool.query("truncate voice_lines")).rejects.toMatchObject({ code: "42501" });
    await touchLine(db.pool, KEY);
  });
});
