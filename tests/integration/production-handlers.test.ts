import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DRY_RUN_NOTES } from "@/lib/dry-run";
import type { ChildRegistry } from "@/server/render/child";
import { createVideoRow } from "@/server/db/videos";
import { productionHandlers, productionStageDeps } from "@/worker/handlers";
import { withTestDb, type TestDb } from "../support/db";

let db: TestDb;
beforeAll(async () => { db = await withTestDb(); });
afterAll(async () => { await db?.stop(); });
beforeEach(async () => { await db.reset(); });

const registry = () => {
  const calls: string[] = [];
  const reg: ChildRegistry = { register: async (r) => { calls.push(`register ${r.commandLabel}`); }, unregister: async () => { calls.push("unregister"); } };
  return { calls, reg };
};

describe("production handlers", () => {
  it("wires tts, voice and sfx only; build/generate/render/qa stay missing", () => {
    const h = productionHandlers(db.pool);
    expect(Object.keys(h).sort()).toEqual(["draft", "sfx", "tts", "voice"]);
  });

  it("a dry-run video is refused by the production tts handler", async () => {
    const v = await createVideoRow(db.pool, { format: "short", kind: "scene_kit", language: "en", topic: "dry", notes: DRY_RUN_NOTES });
    const ctx = { stage: { id: "s", name: "tts", inputHash: "h", videoId: v.id } } as never;
    await expect(productionHandlers(db.pool).tts!(ctx)).rejects.toThrow(/dry-run video/);
  });

  it("every ffmpeg/ffprobe child goes through the worker's registry", async () => {
    const { calls, reg } = registry();
    const deps = productionStageDeps(db.pool, { childRegistry: reg });
    // The child must outlive runChild's process-info read, or it is (correctly) not tracked: an instant exit made this flaky on CI.
    const r = await deps.mix!.runChild({ command: process.execPath, args: ["-e", "setTimeout(() => {}, 500)"], cwd: process.cwd(), timeoutMs: 10_000, maxOutputBytes: 1024, signal: new AbortController().signal, stageRunId: "00000000-0000-0000-0000-000000000000" });
    expect(r.code).toBe(0);
    expect(calls).toEqual([expect.stringMatching(/^register /), "unregister"]);
  });

  it("whisper alignment is wired only when WHISPER_MODEL is set", () => {
    const { reg } = registry();
    const was = process.env.WHISPER_MODEL;
    try {
      delete process.env.WHISPER_MODEL;
      expect(productionStageDeps(db.pool, { childRegistry: reg }).align).toBeUndefined();
      process.env.WHISPER_MODEL = "/models/x.bin";
      expect(productionStageDeps(db.pool, { childRegistry: reg }).align).toBeTypeOf("function");
    } finally {
      if (was === undefined) delete process.env.WHISPER_MODEL; else process.env.WHISPER_MODEL = was;
    }
  });
});

describe("production image wiring", () => {
  it("imageFor refuses an unknown, off or unkeyed image provider before any money moves", async () => {
    const imageFor = productionStageDeps(db.pool).imageFor!;
    await expect(imageFor("elevenlabs")).rejects.toThrow(/not an image provider/);
    await expect(imageFor("fal_image")).rejects.toThrow(/off or has no price/);
  });
});
