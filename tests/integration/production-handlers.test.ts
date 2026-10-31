import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { readAssetRef } from "@/server/providers/image/wire";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DRY_RUN_NOTES } from "@/lib/dry-run";
import type { ChildRegistry } from "@/server/render/child";
import { createVideoRow } from "@/server/db/videos";
import { productionHandlers, productionStageDeps, renderKitDir } from "@/worker/handlers";
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
  it("wires tts, render, voice, sfx and qa; build and generate stay missing", () => {
    const h = productionHandlers(db.pool);
    expect(Object.keys(h).sort()).toEqual(["draft", "qa", "render", "sfx", "tts", "voice"]);
  });

  it("the kit folder comes from the code's own location, symlinks resolved; a symlinked kit is passed unresolved (and refused)", () => {
    expect(renderKitDir()).toBe(realpathSync(path.resolve("remotion/kit")));
    const tmp = realpathSync(mkdtempSync(path.join(tmpdir(), "kit-")));
    mkdirSync(path.join(tmp, "remotion"));
    symlinkSync(path.resolve("remotion/kit"), path.join(tmp, "remotion", "kit"));
    mkdirSync(path.join(tmp, "src", "worker"), { recursive: true });
    expect(renderKitDir(path.join(tmp, "src", "worker"))).toBe(path.join(tmp, "remotion", "kit"));
    rmSync(tmp, { recursive: true, force: true });
  });

  it("the production renderer is the container renderer and refuses a call without validated scenes", async () => {
    const ctx = { claim: { stageRunId: "r" }, attemptDir: "/nonexistent" } as never;
    await expect(productionStageDeps(db.pool).renderer.render(ctx, { sceneFile: "x", outFile: "render.mp4", size: { width: 1080, height: 1920 } })).rejects.toThrow(/checked scenes/);
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

describe("image wiring refusals", () => {
  it("a priced, enabled provider with no saved key refuses before anything is reserved", async () => {
    await db.ownerPool.query(`insert into media_providers (id, kind, label, enabled, price) values ('fal_image', 'image', 'fal', true, '{"unit":"per_image","microUsd":3000}')`);
    await expect(productionStageDeps(db.pool).imageFor!("fal_image")).rejects.toThrow(/save its key first/);
    expect((await db.pool.query("select 1 from spend_intents")).rowCount).toBe(0);
  });
  it("readAssetRef: missing asset, escaping path and oversize file are refused", async () => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), "ref-")));
    const asset = async (ref: string) => (await db.pool.query<{ id: string }>(
      "insert into assets (kind, original_name, mime, bytes, sha256, storage_ref, source, rights) values ('image','a.png','image/png',1,$1,$2,'upload',$3) returning id", [createHash("sha256").update(ref).digest("hex"), ref, JSON.stringify({ attestations: ["own"] })])).rows[0]!.id;
    const read = readAssetRef(db.pool, root);
    await expect(read("00000000-0000-0000-0000-000000000000")).rejects.toThrow(/no longer exists/);
    await expect(read(await asset("../../etc/passwd"))).rejects.toThrow(/could not be read/);
    writeFileSync(path.join(root, "big.png"), Buffer.alloc(10 * 1024 * 1024 + 1));
    await expect(read(await asset("big.png"))).rejects.toThrow(/too big/);
    writeFileSync(path.join(root, "ok.png"), "x");
    expect((await read(await asset("ok.png"))).length).toBe(1);
  });
});
