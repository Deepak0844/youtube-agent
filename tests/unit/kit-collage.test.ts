import { describe, expect, it } from "vitest";
import { validateScenes } from "@/shared/scene";
import { KIND } from "@/shared/scene/kinds/collage";
import { collageRects, enterState, type CollageLayout } from "../../remotion/kit/helpers";
import { theme } from "../../remotion/kit/theme";

const tile = (asset: string) => ({ asset });
const col = { id: "s1", beat: "b1", kind: "collage", startMs: 0, durationMs: 4000, layout: "grid2", tiles: [tile("img_a"), tile("clip_b")] };
const doc = (...scenes: unknown[]) => ({ version: 1, scenes });
const errs = (d: unknown) => {
  const r = validateScenes(d);
  return r.ok ? [] : r.errors;
};
const box = { x: theme.safe.side, y: theme.safe.top, w: theme.width - theme.safe.side * 2, h: theme.height - theme.safe.top - theme.safe.bottom };

describe("collage kind", () => {
  it("uses the id the re-frame predicate skips", () => expect(KIND).toBe("collage"));
  it("accepts 2 tiles and fills defaults", () => {
    const r = validateScenes(doc(col));
    expect(r.ok).toBe(true);
    if (r.ok && r.doc.scenes[0]?.kind === "collage") expect(r.doc.scenes[0].tiles[0]).toMatchObject({ media: "image", enter: "fade", delayMs: 300 });
  });
  it("rejects 1 or 7 tiles, URLs, bad layout, long delay", () => {
    expect(errs(doc({ ...col, tiles: [tile("img_a")] }))[0]).toBe("scene 1 > tiles: needs at least 2 tiles");
    expect(errs(doc({ ...col, tiles: Array(7).fill(tile("img_a")) }))[0]).toBe("scene 1 > tiles: must have at most 6 tiles");
    expect(errs(doc({ ...col, tiles: [tile("http://x.com/a.png"), tile("b")] }))[0]).toContain("scene 1 > tiles > 0 > asset");
    expect(errs(doc({ ...col, layout: "masonry" }))[0]).toContain("scene 1 > layout");
    expect(errs(doc({ ...col, tiles: [{ asset: "a", delayMs: 9000 }, tile("b")] }))[0]).toContain("delayMs");
  });
  it.each(["grid2", "grid3", "hero_plus_strip", "stagger"] as CollageLayout[])("%s keeps every tile inside the safe area", (layout) => {
    for (let n = 2; n <= 6; n++) {
      const rs = collageRects(layout, n, box);
      expect(rs).toHaveLength(n);
      for (const r of rs) {
        expect(r.x).toBeGreaterThanOrEqual(box.x - 0.01);
        expect(r.y).toBeGreaterThanOrEqual(box.y - 0.01);
        expect(r.x + r.w).toBeLessThanOrEqual(box.x + box.w + 0.01);
        expect(r.y + r.h).toBeLessThanOrEqual(box.y + box.h + 0.01);
        expect(r.w).toBeGreaterThan(100);
        expect(r.h).toBeGreaterThan(100);
      }
    }
  });
  it("enterState starts hidden and ends at rest", () => {
    expect(enterState("rise", 0, 0).opacity).toBe(0);
    expect(enterState("rise", 0, 0).y).toBeGreaterThan(0);
    expect(enterState("pop", 99, 0)).toEqual({ opacity: 1, x: 0, y: 0, scale: 1 });
    expect(enterState("fade", 0, 10).opacity).toBe(0);
  });
});
