import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { clipCutProblem, cutClipArgs } from "@/server/core/clip-cut";
import { assertFfprobeAvailable } from "../support/tools";

const base = { inFile: "/in/source.mp4", outFile: "/out/clip.mp4", startS: 12.5, endS: 42.5 };

describe("cutClipArgs", () => {
  it("cuts the window, fits over a blurred fill and keeps the file protocol only", () => {
    const a = cutClipArgs(base);
    expect(a.slice(a.indexOf("-protocol_whitelist"), a.indexOf("-protocol_whitelist") + 2)).toEqual(["-protocol_whitelist", "file"]);
    expect(a[a.indexOf("-ss") + 1]).toBe("12.500");
    expect(a[a.indexOf("-t") + 1]).toBe("30.000");
    expect(a[a.indexOf("-i") + 1]).toBe("/in/source.mp4");
    expect(a.at(-1)).toBe("/out/clip.mp4");
    const graph = a[a.indexOf("-filter_complex") + 1]!;
    expect(graph).toContain("boxblur");
    expect(graph).toContain("force_original_aspect_ratio=decrease"); // sharp copy fitted, not cropped
    expect(graph).toContain("force_original_aspect_ratio=increase,crop=1080:1920"); // blurred copy fills the frame
  });

  it("can crop the bottom off the sharp picture (burned-in captions) from both copies and refuses a silly crop", () => {
    const g = cutClipArgs({ ...base, cropBottom: 0.1 }).join(" ");
    expect(g).toContain("[0:v]crop=iw:trunc(ih*0.900/2)*2:0:0,split=2[a][b]");
    expect(cutClipArgs(base).join(" ")).not.toContain("trunc(ih");
    expect(clipCutProblem({ ...base, cropBottom: 0.5 })).toMatch(/crop/);
  });

  it("refuses bad times and option-looking file names in plain words", () => {
    for (const bad of [{ startS: -1 }, { endS: 5 }, { startS: Number.NaN }, { endS: Number.POSITIVE_INFINITY }, { endS: 12.5 }, { endS: 200 }]) {
      expect(clipCutProblem({ ...base, ...bad }), JSON.stringify(bad)).toEqual(expect.any(String));
      expect(() => cutClipArgs({ ...base, ...bad })).toThrow();
    }
    expect(clipCutProblem({ ...base, inFile: "-i" })).toMatch(/file names/);
    expect(clipCutProblem({ ...base, outFile: "" })).toMatch(/file names/);
    expect(clipCutProblem(base)).toBeNull();
  });
});

describe("cutClipArgs with real ffmpeg", () => {
  let dir = "";
  beforeAll(() => {
    assertFfprobeAvailable();
    dir = mkdtempSync(path.join(tmpdir(), "clipcut-"));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const probe = (f: string) => {
    const r = spawnSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type,width,height:format=duration", "-of", "json", f], { encoding: "utf8" });
    return JSON.parse(r.stdout) as { streams: { codec_type: string; width?: number; height?: number }[]; format: { duration: string } };
  };
  const source = (name: string, size: string) => {
    const f = path.join(dir, name);
    const r = spawnSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", `testsrc2=size=${size}:rate=30:duration=8`, "-f", "lavfi", "-i", "sine=frequency=440:duration=8", "-shortest", "-pix_fmt", "yuv420p", f]);
    expect(r.status).toBe(0);
    return f;
  };

  it.each([["landscape", "640x360"], ["portrait", "360x640"], ["square", "400x400"]])("a %s source comes out 1080x1920 with sound and the cut length", (name, size) => {
    const out = path.join(dir, `${name}-clip.mp4`);
    const r = spawnSync("ffmpeg", cutClipArgs({ inFile: source(`${name}.mp4`, size), outFile: out, startS: 1, endS: 4 }));
    expect(r.status, r.stderr?.toString()).toBe(0);
    const p = probe(out);
    const v = p.streams.find((s) => s.codec_type === "video")!;
    expect([v.width, v.height]).toEqual([1080, 1920]);
    expect(p.streams.some((s) => s.codec_type === "audio")).toBe(true);
    expect(Number(p.format.duration)).toBeGreaterThan(2.8);
    expect(Number(p.format.duration)).toBeLessThan(3.3);
  }, 60_000); // real encodes; the CI runner is slower than a laptop
});
