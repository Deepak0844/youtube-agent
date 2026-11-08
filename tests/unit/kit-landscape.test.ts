import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { activeChapter, blockSizes, chapterCardFrames, frameLayout, landscapeFrames, lowerThirdOpacity, progressSegments, stageGeometry } from "../../remotion/kit/frameLayout";
import { theme } from "../../remotion/kit/theme";

describe("frameLayout portrait", () => {
  it("pins today's portrait numbers exactly (shorts must render as before)", () => {
    expect(frameLayout("portrait")).toEqual({
      width: 1080,
      height: 1920,
      safe: { top: 220, bottom: 424, side: 72 },
      captionFont: 68,
      captionMaxChars: 28,
      captionBottom: 424,
      titleFont: 72,
      bodyFont: 46,
    });
  });
  it("is derived from the theme, so the two cannot drift", () => {
    const p = frameLayout("portrait");
    expect([p.width, p.height, p.safe, p.titleFont, p.bodyFont, p.captionMaxChars]).toEqual([theme.width, theme.height, theme.safe, theme.type.title, theme.type.body, theme.copy.maxCharsPerLine]);
  });
});

describe("frameLayout landscape", () => {
  const l = frameLayout("landscape");
  it("is 1920x1080 with safe areas that leave room", () => {
    expect([l.width, l.height]).toEqual([1920, 1080]);
    expect(l.safe.top + l.safe.bottom).toBeLessThan(l.height);
    expect(l.safe.side * 2).toBeLessThan(l.width);
  });
  it("uses wider lines and a lower caption band than portrait", () => {
    expect(l.captionMaxChars).toBeGreaterThan(frameLayout("portrait").captionMaxChars);
    expect(l.captionBottom).toBeLessThan(frameLayout("portrait").captionBottom);
    expect(l.captionBottom).toBe(l.safe.bottom);
  });
});

describe("stageGeometry", () => {
  it("centres a 1080x1920 stage in the landscape frame at full height", () => {
    const g = stageGeometry();
    expect(g.scale).toBeCloseTo(1080 / 1920, 6);
    expect(g.left).toBeCloseTo((1920 - 1080) / 2, 6);
    expect(g.top).toBeCloseTo((1080 - 1920) / 2, 6);
  });
});

describe("chapters", () => {
  const ch = [
    { title: "Intro", startMs: 0 },
    { title: "Part 1", startMs: 60_000 },
    { title: "Part 2", startMs: 120_000 },
  ];
  it("finds the active chapter", () => {
    expect(activeChapter(ch, 0)).toBe(0);
    expect(activeChapter(ch, 59_999)).toBe(0);
    expect(activeChapter(ch, 60_000)).toBe(1);
    expect(activeChapter(ch, 999_999)).toBe(2);
    expect(activeChapter([], 5)).toBe(-1);
  });
  it("progress segments follow chapter lengths and fill the current one", () => {
    const s = progressSegments(ch, 180_000, 90_000);
    expect(s.map((x) => x.weight)).toEqual([1, 1, 1]);
    expect(s.map((x) => x.fill)).toEqual([1, 0.5, 0]);
  });
  it("progress with no chapters is one segment", () => {
    expect(progressSegments([], 100_000, 25_000)).toEqual([{ weight: 1, fill: 0.25 }]);
  });
  it("chapter card lasts 3 s but never past the chapter", () => {
    expect(chapterCardFrames(ch, 1, 180_000, 30)).toBe(90);
    expect(chapterCardFrames([{ title: "x", startMs: 0 }], 0, 1000, 30)).toBe(30);
  });
});

describe("lowerThirdOpacity", () => {
  it("fades in, holds and fades out within its window", () => {
    expect(lowerThirdOpacity(0, 90)).toBe(0);
    expect(lowerThirdOpacity(45, 90)).toBe(1);
    expect(lowerThirdOpacity(90, 90)).toBe(0);
  });
});

describe("blockSizes", () => {
  it("lower third clears the caption band in both layouts", () => {
    for (const l of ["portrait", "landscape"] as const) {
      const b = blockSizes(l);
      expect(b.thirdBottom).toBeGreaterThan(frameLayout(l).captionBottom);
      expect(b.thirdLeft).toBe(frameLayout(l).safe.side);
    }
  });
  it("landscape title is bigger than portrait and the bar sits below the caption band", () => {
    expect(blockSizes("landscape").cardTitle).toBeGreaterThan(blockSizes("portrait").cardTitle);
    expect(blockSizes("landscape").barBottom).toBeLessThan(frameLayout("landscape").captionBottom);
  });
});

describe("landscape composition registration", () => {
  it("registers kit-video-landscape at 1920x1080 next to the unchanged portrait kit-video", () => {
    const src = readFileSync(path.join(__dirname, "../../remotion/kit/registry.tsx"), "utf8");
    expect(src).toMatch(/id="kit-video-landscape"[\s\S]*?width=\{LANDSCAPE_SIZE\.width\}[\s\S]*?height=\{LANDSCAPE_SIZE\.height\}/);
    expect(src).toMatch(/id="kit-video"[\s\S]*?width=\{theme\.width\}\s+height=\{theme\.height\}/);
  });
});

describe("landscapeFrames", () => {
  it("duration follows the input: minutes, not seconds", () => {
    expect(landscapeFrames([{ startMs: 0, durationMs: 120_000 }], 30)).toBe(3600);
  });
});
