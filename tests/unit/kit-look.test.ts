import { describe, expect, it } from "vitest";
import { contrast, firstPictureId, HOOK_FADE_FRAMES, HOOK_FRAMES, hookOpacity, shortTitle, fitContain, gentleMotion, keyWordIndex, LOOKS, lookBackground, pickLook, popScale, sceneCaptionAllowed } from "../../remotion/kit/look";
import { defaultTheme } from "../../remotion/kit/theme";

describe("pickLook", () => {
  it("is deterministic and always from the curated list", () => {
    expect(pickLook("video-1")).toBe(pickLook("video-1"));
    for (const s of ["a", "b", "topic x", "", "🙂"]) expect(LOOKS).toContain(pickLook(s));
  });
  it("uses more than one palette across seeds", () => {
    expect(new Set(Array.from({ length: 40 }, (_, i) => pickLook(`v${i}`).name)).size).toBeGreaterThan(2);
  });
  it("every palette has good contrast", () => {
    for (const l of LOOKS) {
      for (const bg of [l.from, l.to]) expect(contrast("#f2f4f8", bg)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(l.accent, l.from)).toBeGreaterThanOrEqual(4.5);
      expect(lookBackground(l)).toContain(l.from);
    }
  });
});

describe("headline and motion", () => {
  it("highlights the longest word", () => {
    expect(keyWordIndex("why planes stay up".split(" "))).toBe(1);
    expect(keyWordIndex([])).toBe(-1);
  });
  it("caps zoom at 6% and pan", () => {
    const k = gentleMotion({ zoomFrom: 1, zoomTo: 1.4, panX: 0.2, panY: -0.2 });
    expect(k).toEqual({ zoomFrom: 1, zoomTo: 1.06, panX: 0.015, panY: -0.015 });
  });
  it("pop-in settles at 1", () => {
    expect(popScale(0)).toBeCloseTo(0.82);
    expect(popScale(50)).toBeCloseTo(1);
  });
});

describe("fitContain", () => {
  it("shows a landscape picture whole, never cropped", () => {
    const r = fitContain({ w: 1600, h: 900 }, { x: 72, y: 220, w: 936, h: 1276 });
    expect(r.w).toBeCloseTo(936);
    expect(r.h).toBeCloseTo(526.5);
    expect(r.w / r.h).toBeCloseTo(1600 / 900);
    expect(r.y).toBeGreaterThan(220);
  });
});

describe("one caption layer", () => {
  const words = [{ word: "hi", startS: 1, endS: 1.5 }];
  it("scene caption hidden only while a spoken word is showing", () => {
    expect(sceneCaptionAllowed(undefined, 1.2)).toBe(true);
    expect(sceneCaptionAllowed([], 1.2)).toBe(true);
    expect(sceneCaptionAllowed(words, 1.2)).toBe(false);
    expect(sceneCaptionAllowed(words, 0.2)).toBe(true);
    expect(sceneCaptionAllowed(words, 5)).toBe(true);
  });
});

describe("safe area", () => {
  it("reserves the bottom 22% for captions", () => {
    expect(defaultTheme.safe.bottom / defaultTheme.height).toBeGreaterThanOrEqual(0.22);
  });
});

describe("hook card", () => {
  it("is fully opaque at frame 0 and gone by the end, fading over 12 frames", () => {
    expect(hookOpacity(0)).toBe(1);
    expect(hookOpacity(HOOK_FRAMES - HOOK_FADE_FRAMES)).toBe(1);
    expect(hookOpacity(HOOK_FRAMES - 6)).toBeCloseTo(0.5);
    expect(hookOpacity(HOOK_FRAMES)).toBe(0);
  });
  it("shortens titles to at most 5 words, dropping leading filler only when too long", () => {
    expect(shortTitle("Why do planes stay up in the sky?")).toBe("planes stay up in the");
    expect(shortTitle("Why planes stay up")).toBe("Why planes stay up");
    expect(shortTitle("")).toBe("Watch this");
    expect(shortTitle(undefined)).toBe("Watch this");
  });
  it("picks the first usable linked picture in scene order", () => {
    const doc = { scenes: [{ kind: "terminal" }, { asset: "clip" }, { items: [{ image: "pic1" }, { image: "pic2" }] }] };
    expect(firstPictureId(doc, (id) => id !== "clip")).toBe("pic1");
    expect(firstPictureId(doc, () => false)).toBeUndefined();
  });
});
