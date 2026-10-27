import { mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildEngineConfig } from "@/server/core/engine-config";
import { LANGS, wordCount, wordRange } from "@/server/core/lang";
import { KnownFailure } from "@/server/core/paid-call";
import { evaluateQa } from "@/server/core/qa";
import { validateScript } from "@/server/core/script-contract";
import type { StageContext } from "@/server/core/stage-handler";
import { fakeModelStep } from "@/server/llm/fake-step";
import { createFakeImage } from "@/server/providers/media/fake";
import { hangs, knownFailure, ok, throwsUnknown } from "@/server/providers/fake-base";
import { createFakeRenderer } from "@/server/providers/renderer/fake";
import { createFakeUploader } from "@/server/providers/uploader/fake";
import { createFakeVoice } from "@/server/providers/voice/fake";
import { probeVideo } from "@/server/render/probe";
import { assertFfprobeAvailable } from "../support/tools";

let dir: string;
const fixtures = realpathSync(path.resolve(__dirname, "../fixtures/video"));
const cfg = buildEngineConfig(new Map()).qa;

const ctxFor = (signal: AbortSignal = new AbortController().signal, id = "run-1"): StageContext =>
  ({ claim: { stageRunId: id }, attemptDir: dir, signal }) as unknown as StageContext;

beforeAll(() => {
  dir = realpathSync(mkdtempSync(path.join(tmpdir(), "fakes-")));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("fake voice", () => {
  it("obeys its interface and is deterministic", async () => {
    const v = createFakeVoice();
    const a = await v.synthesise(ctxFor(), { text: "one two three four", lang: "en", voice: "fake" });
    const b = await v.synthesise(ctxFor(), { text: "one two three four", lang: "en", voice: "fake" });
    expect(a.wordTimings).toBe("estimated");
    expect(a.priceMicroUsd).toBeGreaterThanOrEqual(0);
    expect(path.dirname(a.audioPath)).toBe(dir);
    expect(readFileSync(a.audioPath).subarray(0, 4).toString()).toBe("RIFF");
    expect(readFileSync(a.audioPath).equals(readFileSync(b.audioPath))).toBe(true);
    expect(v.totalCalls()).toBe(2);
  });
  it("scripted outcomes: price, known failure, unknown failure", async () => {
    const v = createFakeVoice({ script: [ok(777), knownFailure("voice refused"), throwsUnknown("socket hang up")] });
    const input = { text: "hello there", lang: "en" as const, voice: "x" };
    expect((await v.synthesise(ctxFor(), input)).priceMicroUsd).toBe(777);
    await expect(v.synthesise(ctxFor(), input)).rejects.toBeInstanceOf(KnownFailure);
    const err = await v.synthesise(ctxFor(), input).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(KnownFailure);
  });
  it("hangs honours the abort signal", async () => {
    const v = createFakeVoice({ script: [hangs(60_000)] });
    const ctl = new AbortController();
    const p = v.synthesise(ctxFor(ctl.signal), { text: "a b", lang: "en", voice: "x" });
    setTimeout(() => ctl.abort(new Error("stop")), 20);
    await expect(p).rejects.toThrow("stop");
  });
});

describe("fake image", () => {
  it("writes a PNG, reports price, maps known failure", async () => {
    const im = createFakeImage({ script: [ok(4000), knownFailure("blocked prompt")] });
    const r = await im.generate(ctxFor(), { prompt: "a cat", size: { width: 1080, height: 1920 } });
    expect(r.priceMicroUsd).toBe(4000);
    expect(readFileSync(r.imagePath).subarray(1, 4).toString()).toBe("PNG");
    await expect(im.generate(ctxFor(), { prompt: "a cat", size: { width: 1, height: 1 } })).rejects.toBeInstanceOf(KnownFailure);
    expect(im.totalCalls()).toBe(2);
  });
  it("hangs honours the abort signal", async () => {
    const im = createFakeImage({ script: [hangs(60_000)] });
    const ctl = new AbortController();
    ctl.abort(new Error("gone"));
    await expect(im.generate(ctxFor(ctl.signal), { prompt: "p", size: { width: 1, height: 1 } })).rejects.toThrow("gone");
  });
});

describe("fake renderer", () => {
  it("copies the fixture mp4 into the attempt dir", async () => {
    const r = createFakeRenderer();
    const out = await r.render(ctxFor(), { sceneFile: "scene.tsx", outFile: "out.mp4", size: { width: 1080, height: 1920 } });
    expect(out.outPath).toBe(path.join(dir, "out.mp4"));
    expect(readFileSync(out.outPath).equals(readFileSync(path.join(fixtures, "good.mp4")))).toBe(true);
  });
  it("refuses an output name that escapes the attempt dir", async () => {
    const r = createFakeRenderer();
    await expect(r.render(ctxFor(), { sceneFile: "s", outFile: "../evil.mp4", size: { width: 1, height: 1 } })).rejects.toThrow(/outFile/);
  });
  it("scripted known failure maps to KnownFailure", async () => {
    const r = createFakeRenderer({ script: [knownFailure("bad scene")] });
    await expect(r.render(ctxFor(), { sceneFile: "s", outFile: "o.mp4", size: { width: 1, height: 1 } })).rejects.toBeInstanceOf(KnownFailure);
  });
});

describe("fake uploader", () => {
  it("reports progress and returns uploaded with a fake id", async () => {
    const u = createFakeUploader();
    const seen: number[] = [];
    const out = await u.upload("up-1", async (n) => void seen.push(n), new AbortController().signal);
    expect(out).toEqual({ kind: "uploaded", youtubeId: "fake-up-1" });
    expect(seen.length).toBeGreaterThan(0);
    expect([...seen].sort((a, b) => a - b)).toEqual(seen);
    expect(u.totalCalls()).toBe(1);
  });
  it("scripted known failure becomes a failed outcome; unknown failure throws", async () => {
    const u = createFakeUploader({ script: [knownFailure("quota"), throwsUnknown("boom")] });
    const sig = new AbortController().signal;
    expect(await u.upload("u", async () => {}, sig)).toEqual({ kind: "failed", reason: "quota" });
    await expect(u.upload("u", async () => {}, sig)).rejects.toThrow("boom");
  });
  it("hangs honours the abort signal", async () => {
    const u = createFakeUploader({ script: [hangs(60_000)] });
    const ctl = new AbortController();
    const p = u.upload("u", async () => {}, ctl.signal);
    ctl.abort(new Error("cancelled"));
    await expect(p).rejects.toThrow("cancelled");
  });
});

describe("fakeModelStep", () => {
  const msgs = [{ role: "user" as const, content: "write" }];
  it("returns valid Draft JSON for all six languages by default", async () => {
    for (const lang of LANGS) {
      const step = fakeModelStep({ lang });
      const res = await step(msgs, "k1");
      expect(res.toolCalls).toEqual([]);
      const v = validateScript(JSON.parse(res.text), lang, "short");
      expect(v, `${lang}: ${JSON.stringify(v)}`).toMatchObject({ ok: true });
      const { min, max } = wordRange(lang);
      const words = wordCount(JSON.parse(res.text).narration as string);
      expect(words).toBeGreaterThanOrEqual(min);
      expect(words).toBeLessThanOrEqual(max);
    }
  });
  it("plays a script of results and errors in order, then repeats the last", async () => {
    const r1 = { text: "a", toolCalls: [], usage: { inputTokens: 1, outputTokens: 2 } };
    const step = fakeModelStep({ script: [r1, new Error("model down")] });
    expect(await step(msgs, "k1")).toEqual(r1);
    await expect(step(msgs, "k2")).rejects.toThrow("model down");
    await expect(step(msgs, "k3")).rejects.toThrow("model down");
  });
  it("honours an already-aborted signal", async () => {
    const ctl = new AbortController();
    ctl.abort(new Error("stop"));
    await expect(fakeModelStep()(msgs, "k", ctl.signal)).rejects.toThrow("stop");
  });
});

describe("fixtures", () => {
  beforeAll(() => assertFfprobeAvailable());
  const probe = (name: string) => probeVideo(path.join(fixtures, name), new AbortController().signal, { storageRoot: fixtures });
  const qa = (p: Awaited<ReturnType<typeof probe>>) => evaluateQa(p, cfg, { expectAudio: true, format: "short" });
  const failed = (r: ReturnType<typeof qa>) => r.checks.filter((c) => !c.ok && c.level === "fail").map((c) => c.id);

  it("every fixture stays under 200 KB", () => {
    for (const n of ["good", "short", "wrong-size", "no-audio", "loop-mismatch", "corrupt"]) {
      expect(statSync(path.join(fixtures, `${n}.mp4`)).size).toBeLessThan(200 * 1024);
    }
  });
  it("good.mp4 is 1080x1920, ~20 s, has audio, first and last frames match", async () => {
    const p = await probe("good.mp4");
    expect(p).toMatchObject({ width: 1080, height: 1920, hasAudio: true });
    expect(p.durationS).toBeCloseTo(20, 0);
    expect(p.loopDiff).toBeLessThan(cfg.loopDiffMax);
    expect(qa(p).pass).toBe(true);
  });
  it("loop-mismatch.mp4 has a different last frame", async () => {
    const p = await probe("loop-mismatch.mp4");
    expect(p.loopDiff).toBeGreaterThan(cfg.loopDiffMax);
    expect(qa(p).checks.some((c) => c.id === "loop_seam" && !c.ok)).toBe(true);
  });
  it("short, wrong-size and no-audio fail the matching check", async () => {
    expect(failed(qa(await probe("short.mp4")))).toEqual(["duration"]);
    expect(failed(qa(await probe("wrong-size.mp4")))).toContain("size");
    const na = await probe("no-audio.mp4");
    expect(na.hasAudio).toBe(false);
    expect(failed(qa(na))).toContain("audio_present");
  });
  it("corrupt.mp4 cannot be probed", async () => {
    await expect(probe("corrupt.mp4")).rejects.toThrow();
  });
});
