import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { KnownFailure } from "@/server/core/paid-call";
import type { StageContext } from "@/server/core/stage-handler";
import { cleanClipPrompt, clipProblem, lockedCharacterProblem, microPerSecondFromTokenRate, quoteClip, seedanceTokens, MAX_CLIP_PROMPT, type ClipRequest } from "@/server/core/video-clip";
import { hangs, knownFailure, throwsUnknown } from "@/server/providers/fake-base";
import { clipScopes, isMp4, pickVideoModel, saveClip, MAX_CLIP_BYTES } from "@/server/providers/video";
import { createFakeVideo, FAKE_MODEL, FAKE_MP4, FAKE_TEXT_ONLY_MODEL } from "@/server/providers/video/fake";

const req = (o: Partial<ClipRequest> = {}): ClipRequest => ({ prompt: "a fox runs", seconds: 5, aspect: "9:16", startImage: false, endImage: false, ...o });

describe("clipProblem", () => {
  it("accepts a normal request", () => expect(clipProblem(FAKE_MODEL, req())).toBeNull());
  it("refuses empty, control-only and over-long prompts", () => {
    expect(clipProblem(FAKE_MODEL, req({ prompt: "" }))).toMatch(/description/);
    expect(clipProblem(FAKE_MODEL, req({ prompt: "\u0000\u0007  " }))).toMatch(/description/);
    expect(clipProblem(FAKE_MODEL, req({ prompt: "x".repeat(MAX_CLIP_PROMPT + 1) }))).toMatch(/description/);
    expect(clipProblem(FAKE_MODEL, req({ prompt: "x".repeat(MAX_CLIP_PROMPT) }))).toBeNull();
  });
  it("refuses a shape or a length the model cannot do, and non-whole lengths", () => {
    expect(clipProblem(FAKE_TEXT_ONLY_MODEL, req({ aspect: "16:9" }))).toMatch(/shape/);
    expect(clipProblem(FAKE_MODEL, req({ seconds: 1 }))).toMatch(/2 to 10/);
    expect(clipProblem(FAKE_MODEL, req({ seconds: 11 }))).toMatch(/2 to 10/);
    for (const s of [2.5, NaN, Infinity]) expect(clipProblem(FAKE_MODEL, req({ seconds: s }))).toMatch(/whole number/);
  });
  it("refuses pictures the model cannot take, and an end picture without a start picture", () => {
    expect(clipProblem(FAKE_TEXT_ONLY_MODEL, req({ startImage: true }))).toMatch(/start from a picture/);
    expect(clipProblem(FAKE_MODEL, req({ endImage: true }))).toMatch(/end picture/);
    expect(clipProblem(FAKE_MODEL, req({ startImage: true, endImage: true }))).toBeNull();
  });
  it("a model that needs a start picture refuses a words-only clip", () => {
    const m = { ...FAKE_MODEL, id: "needs-image", imageRequired: true };
    expect(clipProblem(m, req())).toMatch(/needs a start picture/);
    expect(clipProblem(m, req({ startImage: true }))).toBeNull();
  });
  it("a model with set lengths refuses the others", () => {
    const m = { ...FAKE_MODEL, id: "set", minSeconds: 4, maxSeconds: 8, allowedSeconds: [4, 6, 8] };
    expect(clipProblem(m, req({ seconds: 6 }))).toBeNull();
    expect(clipProblem(m, req({ seconds: 5 }))).toMatch(/4, 6, 8/);
  });
  it("cleanClipPrompt trims and strips control characters", () => expect(cleanClipPrompt("  a\u0000b  ")).toBe("ab"));
});

describe("quoteClip: the owner's per-second price, rounded up, unpriced refused", () => {
  const p = { unit: "per_second", microUsd: 12_345 };
  it("multiplies by seconds", () => expect(quoteClip(p, 5)).toBe(61_725));
  it("rounds a fractional micro-dollar up", () => expect(quoteClip({ unit: "per_second", microUsd: 1 }, 3)).toBe(3));
  it.each([null, undefined, {}, { unit: "per_image", microUsd: 5 }, { unit: "per_second", microUsd: -1 }, { unit: "per_second", microUsd: 1.5 }, "free"])("refuses %j", (price) => {
    expect(() => quoteClip(price, 5)).toThrow(KnownFailure);
  });
  it("a free rule quotes zero but only as per_second would, so it is refused here too (a free video model is not a thing we quote)", () => {
    expect(() => quoteClip({ unit: "free", microUsd: 0 }, 5)).toThrow(KnownFailure);
  });
});

describe("derived price formulas", () => {
  it("Seedance tokens = w x h x fps x s / 1024", () => {
    expect(seedanceTokens({ width: 1080, height: 1920, fps: 24, seconds: 5 })).toBe(Math.ceil((1080 * 1920 * 24 * 5) / 1024));
  });
  it("turns a price per million tokens into a per-second price, rounded up", () => {
    const d = { width: 1080, height: 1920, fps: 24 };
    const perS = microPerSecondFromTokenRate(2_000_000, d); // $2 per million tokens
    expect(perS).toBe(Math.ceil((2_000_000 * seedanceTokens({ ...d, seconds: 1 })) / 1_000_000));
    expect(perS).toBeGreaterThan(0);
    expect(microPerSecondFromTokenRate(0, d)).toBe(0);
  });
});

describe("pickVideoModel", () => {
  const providers = { fake: createFakeVideo() };
  it("finds a model", () => expect(pickVideoModel(providers, "fake", "fake-video", { locked: false }).model.id).toBe("fake-video"));
  it("refuses an unknown provider or model, including prototype names", () => {
    for (const [p, m] of [["nope", "fake-video"], ["fake", "nope"], ["constructor", "x"], ["fake", "__proto__"]] as const) {
      expect(() => pickVideoModel(providers, p, m, { locked: false })).toThrow(KnownFailure);
    }
  });
  it("a locked character needs a model that starts from a picture; no fallback", () => {
    expect(() => pickVideoModel(providers, "fake", "fake-text-only", { locked: true })).toThrow(/keep a character/);
    expect(pickVideoModel(providers, "fake", "fake-text-only", { locked: false }).model.id).toBe("fake-text-only");
    expect(lockedCharacterProblem(FAKE_MODEL)).toBeNull();
  });
});

describe("clipScopes and the file check", () => {
  it("no budget scope is refused", () => {
    expect(() => clipScopes(undefined)).toThrow(KnownFailure);
    expect(() => clipScopes([])).toThrow(KnownFailure);
    expect(clipScopes(["v"])).toEqual(["v"]);
  });
  it("isMp4 wants the ftyp box", () => {
    expect(isMp4(FAKE_MP4)).toBe(true);
    expect(isMp4(Buffer.from("RIFF....WAVEfmt "))).toBe(false);
    expect(isMp4(Buffer.alloc(4))).toBe(false);
  });
});

describe("saveClip and the fake provider", () => {
  let dir: string;
  beforeAll(() => {
    dir = realpathSync(mkdtempSync(path.join(tmpdir(), "video-clip-")));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const ctx = (id = "r1", signal: AbortSignal = new AbortController().signal) =>
    ({ claim: { stageRunId: id }, attemptDir: dir, paid: async (_s: unknown, f: (k: string, s: AbortSignal) => Promise<{ result: unknown }>) => (await f("k", signal)).result, signal }) as unknown as StageContext;
  const args = (o: Record<string, unknown> = {}) => ({ ...req(), model: "fake-video", budgetScopes: ["v"], ...o });

  it("stores a clip once, content-addressed, with a sidecar; a repeat is the same file", async () => {
    const m = { root: dir, provider: "p", model: "m", prompt: "x", seconds: 5, aspect: "9:16", priceMicroUsd: 7 };
    const a = await saveClip(FAKE_MP4, m);
    const b = await saveClip(FAKE_MP4, m);
    expect(a.path).toBe(b.path);
    expect(a.path).toMatch(/generated-media\/[0-9a-f]{2}\/[0-9a-f]{64}\.mp4$/);
    expect(readFileSync(a.path)).toEqual(FAKE_MP4);
    expect(a.durationS).toBe(5);
    expect(a.provenance.priceMicroUsd).toBe(7);
  });
  it("a file that is not an MP4 is an unknown outcome (plain Error, never a refusal)", async () => {
    const err = await saveClip(Buffer.from("not a video at all"), { root: dir, provider: "p", model: "m", prompt: "x", seconds: 5, aspect: "9:16", priceMicroUsd: 7 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(KnownFailure);
  });
  it("the size limit is 500 MB", () => expect(MAX_CLIP_BYTES).toBe(500 * 1024 * 1024));

  it("quotes from the owner's price and charges what is scripted", async () => {
    const v = createFakeVideo({ priceMicroUsd: 400_000 });
    expect(v.quote(args())).toBe(500_000);
    const out = await v.generate(ctx(), args());
    expect(out.provenance.priceMicroUsd).toBe(400_000);
    expect(out.durationS).toBe(5);
    expect(readFileSync(out.path)).toEqual(FAKE_MP4);
    expect(path.dirname(out.path)).toBe(dir);
  });
  it("refuses before any call when unpriced, over-length, wrong model or no budget", async () => {
    const unpriced = createFakeVideo({ price: null });
    await expect(unpriced.generate(ctx(), args())).rejects.toBeInstanceOf(KnownFailure);
    const v = createFakeVideo();
    await expect(v.generate(ctx(), args({ seconds: 99 }))).rejects.toBeInstanceOf(KnownFailure);
    await expect(v.generate(ctx(), args({ model: "nope" }))).rejects.toBeInstanceOf(KnownFailure);
    await expect(v.generate(ctx(), args({ budgetScopes: [] }))).rejects.toBeInstanceOf(KnownFailure);
    expect(v.totalCalls() + unpriced.totalCalls()).toBe(0);
  });
  it("plays scripted failures: a refusal, an unknown outcome, and a cancel while slow", async () => {
    const refuse = createFakeVideo({ script: [knownFailure("no")] });
    await expect(refuse.generate(ctx(), args())).rejects.toBeInstanceOf(KnownFailure);
    const unknown = createFakeVideo({ script: [throwsUnknown()] });
    const err = await unknown.generate(ctx(), args()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(KnownFailure);
    const ac = new AbortController();
    const slow = createFakeVideo({ script: [hangs(60_000)] });
    const p = slow.generate(ctx("r9", ac.signal), args());
    ac.abort(new Error("cancelled"));
    await expect(p).rejects.toThrow("cancelled");
  });
  it("a locked character is refused for a text-only model even through the fake", async () => {
    const v = createFakeVideo();
    await expect(v.generate(ctx(), args({ model: "fake-text-only", startImage: true }))).rejects.toThrow(/start from a picture/);
  });
});
