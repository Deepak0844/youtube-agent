import { describe, expect, it } from "vitest";
import { isReframeFormat, reframeArgs, reframeFileName, reframeProblem } from "@/server/core/reframe";

const graph = (f: "16x9" | "1x1") => {
  const a = reframeArgs(f, "i", "o");
  return a[a.indexOf("-filter_complex") + 1]!;
};

describe("reframeArgs", () => {
  it("16:9 fills 1920x1080 with a blurred dimmed cover copy and a centred fitted original", () => {
    const a = reframeArgs("16x9", "/in/final.mp4", "/out/final-16x9.mp4");
    const g = graph("16x9");
    expect(g).toContain("scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080,boxblur");
    expect(g).toContain("eq=brightness=-");
    expect(g).toContain("scale=1920:1080:force_original_aspect_ratio=decrease");
    expect(g).toContain("overlay=(W-w)/2:(H-h)/2");
    expect(a.slice(0, 7)).toEqual(["-nostdin", "-hide_banner", "-y", "-protocol_whitelist", "file", "-i", "/in/final.mp4"]);
    expect(a.at(-1)).toBe("/out/final-16x9.mp4");
    expect(a).toContain("0:a?");
  });
  it("1:1 uses 1080x1080", () => {
    expect(graph("1x1")).toContain("scale=1080:1080:force_original_aspect_ratio=increase,crop=1080:1080");
    expect(graph("1x1")).not.toContain("1920");
  });
});

describe("names and skip rules", () => {
  it("names the file next to final.mp4, never final.mp4 itself", () => {
    expect(reframeFileName("16x9")).toBe("final-16x9.mp4");
    expect(reframeFileName("1x1")).toBe("final-1x1.mp4");
  });
  it("accepts only the two formats", () => {
    expect(isReframeFormat("16x9") && isReframeFormat("1x1")).toBe(true);
    expect(isReframeFormat("4x3")).toBe(false);
    expect(isReframeFormat(undefined)).toBe(false);
  });
  it("skips collage videos and collage scenes, allows the normal case", () => {
    expect(reframeProblem("ai", ["chess", "chart"])).toBeNull();
    expect(reframeProblem("ai", [])).toBeNull();
    expect(reframeProblem("collage", [])).toMatch(/collage/);
    expect(reframeProblem("collage", ["chess", "collage"])).toMatch(/collage/);
  });
});
