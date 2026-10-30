import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { StageContext } from "@/server/core/stage-handler";
import { parseWav, wavSeconds } from "@/server/providers/voice/wav";
import { runChild, type ChildSpec } from "@/server/render/child";
import { audioSeconds, GAP_S, joinWithGaps, prepareLine } from "@/worker/stages/voice-audio";
import { assertFfprobeAvailable } from "../support/tools";

// The real ffmpeg/ffprobe through the real child runner: argument shapes are checked by what the files really become.
let dir: string;
const ff = (...a: string[]) => execFileSync("ffmpeg", ["-nostdin", "-v", "error", "-y", ...a]);
const mix = { runChild: (s: ChildSpec) => runChild(s), audioRoot: "" };
const ctx = () => ({ attemptDir: dir, signal: new AbortController().signal, claim: { stageRunId: "voice-audio-test" } }) as unknown as StageContext;

beforeAll(() => {
  assertFfprobeAvailable();
  dir = realpathSync(mkdtempSync(path.join(tmpdir(), "voice-audio-")));
  ff("-f", "lavfi", "-i", "sine=f=220:d=2", "-ar", "44100", "-ac", "2", path.join(dir, "in.wav"));
  ff("-f", "lavfi", "-i", "sine=f=220:d=2", "-c:a", "aac", path.join(dir, "in.m4a"));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("voice audio with the real ffmpeg", () => {
  it("ffprobe reads the length of compressed audio", async () => {
    expect(await audioSeconds(mix, ctx(), path.join(dir, "in.m4a"))).toBeGreaterThan(1.9);
    expect(await audioSeconds(mix, ctx(), path.join(dir, "in.m4a"))).toBeLessThan(2.3);
  });
  it("prepareLine makes mono 16-bit 24 kHz WAV, and a speed-up shortens it by the factor", async () => {
    const plain = await prepareLine(mix, ctx(), path.join(dir, "in.m4a"), path.join(dir, "p.wav"), 1);
    const fast = await prepareLine(mix, ctx(), path.join(dir, "in.m4a"), path.join(dir, "f.wav"), 1.1);
    expect(plain.fmt.readUInt16LE(2)).toBe(1); // mono
    expect(plain.fmt.readUInt32LE(4)).toBe(24000);
    expect(plain.fmt.readUInt16LE(14)).toBe(16);
    expect(wavSeconds(fast) / wavSeconds(plain)).toBeGreaterThan(0.86);
    expect(wavSeconds(fast) / wavSeconds(plain)).toBeLessThan(0.95);
  });
  it("joinWithGaps puts 120 ms of 16-bit silence between lines", async () => {
    const a = await prepareLine(mix, ctx(), path.join(dir, "in.wav"), path.join(dir, "a.wav"), 1);
    const joined = parseWav(joinWithGaps([a, a]));
    expect(wavSeconds(joined)).toBeCloseTo(2 * wavSeconds(a) + GAP_S, 2);
    expect(readFileSync(path.join(dir, "a.wav")).length).toBeGreaterThan(44);
  });
});
