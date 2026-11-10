import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { KnownFailure } from "@/server/core/paid-call";
import type { StageContext } from "@/server/core/stage-handler";
import type { ChildSpec } from "@/server/render/child";
import { cutNarration, type MixDeps } from "@/server/render/mix";

let dir: string;
let seen: ChildSpec[];
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "cut-"));
  seen = [];
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const ctx = () => ({ attemptDir: dir, log: () => undefined, signal: new AbortController().signal, claim: { stageRunId: "run1" } }) as unknown as StageContext;
const window = { startMs: 20_000, durationMs: 30_000 };
const mix = (probeS: number, fail = false): MixDeps => ({
  audioRoot: dir,
  async runChild(spec: ChildSpec) {
    seen.push(spec);
    if (spec.command === "ffmpeg") {
      if (fail) return { code: 1, signal: null, truncated: false, timedOut: false, aborted: false };
      writeFileSync(spec.args[spec.args.length - 1]!, "wav");
    } else spec.onLine?.(String(probeS));
    return { code: 0, signal: null, truncated: false, timedOut: false, aborted: false };
  },
});

describe("cutNarration", () => {
  it("cuts the window with ffmpeg, checks the length, and returns it", async () => {
    const out = path.join(dir, "clip.wav");
    const s = await cutNarration(mix(30.02), ctx(), { narration: path.join(dir, "narration.wav"), out, window });
    expect(s).toBe(30.02);
    expect(seen[0]!.command).toBe("ffmpeg");
    expect(seen[0]!.args).toContain("pcm_s16le");
    expect(seen[0]!.args.slice(seen[0]!.args.indexOf("-ss"), seen[0]!.args.indexOf("-ss") + 4)).toEqual(["-ss", "20.000", "-t", "30.000"]);
    expect(existsSync(out)).toBe(true);
  });
  it("refuses and removes a cut that is not the length of the clip (the narration is shorter than the video)", async () => {
    const out = path.join(dir, "clip.wav");
    const e = await cutNarration(mix(10), ctx(), { narration: path.join(dir, "narration.wav"), out, window }).then(() => null, (x: unknown) => x as Error);
    expect(e).toBeInstanceOf(KnownFailure);
    expect(e?.message).toMatch(/cut narration is 10\.0 s but the clip is 30\.0 s/);
    expect(readdirSync(dir)).toEqual([]);
  });
  it("a failed ffmpeg is a plain failure that names no path", async () => {
    const e = await cutNarration(mix(30, true), ctx(), { narration: path.join(dir, "narration.wav"), out: path.join(dir, "clip.wav"), window }).then(() => null, (x: unknown) => x as Error);
    expect(e).toBeInstanceOf(KnownFailure);
    expect(e?.message).toBe("Cutting the narration failed (ffmpeg returned an error).");
  });
});
