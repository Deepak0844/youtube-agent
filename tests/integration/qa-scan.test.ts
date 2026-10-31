import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { qaFindings } from "@/server/core/qa-findings";
import { ProbeError } from "@/server/render/probe";
import { scanVideo, STILLS } from "@/server/render/qa-scan";
import { assertFfprobeAvailable } from "../support/tools";

let root: string;
const f = (n: string) => path.join(root, n);
const ff = (...a: string[]) => execFileSync("ffmpeg", ["-v", "error", "-y", ...a], { stdio: "pipe" });
const enc = ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-r", "30", "-c:a", "aac", "-shortest"];
const sig = () => new AbortController().signal;
const ids = async (name: string, sev: string) => qaFindings(await scanVideo(f(name), sig(), { storageRoot: root, attemptDir: f("at-" + name) })).filter((x) => x.severity === sev).map((x) => x.id);

beforeAll(() => {
  assertFfprobeAvailable();
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "qascan-")));
  const tone = ["-f", "lavfi", "-i", "sine=frequency=440:duration=6,volume=2.4"];
  // 6 s moving picture with a tone: clean.
  ff("-f", "lavfi", "-i", "testsrc2=s=1080x1920:r=30:d=6", ...tone, ...enc, f("good.mp4"));
  // 3 s black start then a still colour for 3 s; silent audio.
  ff("-f", "lavfi", "-i", "color=c=black:s=1080x1920:r=30:d=6", "-f", "lavfi", "-i", "anullsrc=r=44100:cl=mono", ...enc, f("bad.mp4"));
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("scanVideo (real ffmpeg)", () => {
  it("clean video: no block or warn findings, three stills written", async () => {
    expect(await ids("good.mp4", "block")).toEqual([]);
    expect(await ids("good.mp4", "warn")).toEqual([]);
    for (const s of STILLS) expect(existsSync(path.join(f("at-good.mp4"), s))).toBe(true);
    const scan = await scanVideo(f("good.mp4"), sig(), { storageRoot: root, attemptDir: f("at2") });
    expect(scan.facts).toMatchObject({ audioCodec: "aac", video: { codec: "h264", width: 1080, height: 1920, fps: 30 } });
    expect(scan.lufs).toBeLessThan(-12);
  });
  it("black and silent video blocks on first frame and silence", async () => {
    expect(await ids("bad.mp4", "block")).toEqual(expect.arrayContaining(["first_frame_black", "silent"]));
  });
  it("refuses a path outside the storage root", async () => {
    await expect(scanVideo("/etc/hosts", sig(), { storageRoot: root, attemptDir: f("x") })).rejects.toBeInstanceOf(ProbeError);
  });
});
