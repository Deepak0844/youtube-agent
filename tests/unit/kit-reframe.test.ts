import { describe, expect, it } from "vitest";
import { reframeGeometry, shouldReframe } from "../../remotion/kit/reframe";

describe("reframeGeometry", () => {
  it("16:9 fits by height and fills by width, centred", () => {
    const g = reframeGeometry(1920, 1080);
    expect(g.fit).toBeCloseTo(1080 / 1920);
    expect(g.fill).toBeCloseTo(1920 / 1080);
    expect(g.left).toBe((1920 - 1080) / 2);
    expect(g.top).toBe((1080 - 1920) / 2);
  });
  it("1:1 fits by height too", () => {
    expect(reframeGeometry(1080, 1080).fit).toBeCloseTo(1080 / 1920);
  });
  it("same size as source is a no-op scale", () => {
    const g = reframeGeometry(1080, 1920);
    expect([g.fit, g.fill, g.left, g.top]).toEqual([1, 1, 0, 0]);
  });
});

describe("shouldReframe", () => {
  it("skips transparency and collage", () => {
    expect(shouldReframe({ kinds: ["terminal", "story_kenburns"] })).toBe(true);
    expect(shouldReframe({ kinds: ["terminal"], hasTransparency: true })).toBe(false);
    expect(shouldReframe({ kinds: ["terminal", "collage"] })).toBe(false);
  });
});
