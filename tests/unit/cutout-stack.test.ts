import { describe, expect, it } from "vitest";
import { cutoutRects } from "../../remotion/kit/helpers";
import { planPictureBeat, checkPictureIds } from "@/server/core/scene-build";
import { validateScenes } from "@/shared/scene/validate";

const box = { x: 100, y: 200, w: 800, h: 1200 };
const inside = (r: { x: number; y: number; w: number; h: number }) => r.x >= box.x - 0.001 && r.y >= box.y - 0.001 && r.x + r.w <= box.x + box.w + 0.001 && r.y + r.h <= box.y + box.h + 0.001;

describe("cutoutRects", () => {
  it("gives one rectangle per layer, all inside the box, for 1 to 5 layers (and clamps others)", () => {
    for (const n of [1, 2, 3, 4, 5]) {
      const r = cutoutRects(n, box);
      expect(r).toHaveLength(n);
      expect(r.every(inside), `n=${n}`).toBe(true);
    }
    expect(cutoutRects(0, box)).toHaveLength(1);
    expect(cutoutRects(9, box)).toHaveLength(5);
  });
});

describe("planPictureBeat with cut-outs", () => {
  const ids = ["a", "b", "c"];
  it("all cut-outs become a cut-out stack, in order, at most 5", () => {
    expect(planPictureBeat(ids, undefined, new Set(ids))).toEqual({ kind: "cutout_stack", assets: ids });
    const six = ["1", "2", "3", "4", "5", "6"];
    expect(planPictureBeat(six, undefined, new Set(six))!.assets).toEqual(["1", "2", "3", "4", "5"]);
  });
  it("a mix of cut-outs and plain pictures, or a clip, keeps the old behaviour", () => {
    expect(planPictureBeat(ids, undefined, new Set(["a"]))!.kind).toBe("collage");
    expect(planPictureBeat(["a"], undefined, new Set())!.kind).toBe("story_kenburns");
    expect(planPictureBeat(ids, new Set(["b"]), new Set(ids))!.kind).toBe("stock_clip");
    expect(planPictureBeat([], undefined, new Set())).toBeNull();
    expect(planPictureBeat(ids)!.kind).toBe("collage"); // no cut-out info at all: unchanged
  });
  it("the scene must use exactly the fixed ids, in order", () => {
    expect(checkPictureIds({ kind: "cutout_stack", layers: [{ asset: "a" }, { asset: "b" }] }, ["a", "b"])).toEqual([]);
    expect(checkPictureIds({ kind: "cutout_stack", layers: [{ asset: "b" }, { asset: "a" }] }, ["a", "b"])).not.toEqual([]);
  });
});

describe("the cutout_stack scene", () => {
  const scene = (o: Record<string, unknown> = {}) => ({ version: 1, scenes: [{ id: "s1", beat: "hook", kind: "cutout_stack", startMs: 0, durationMs: 3000, layers: [{ asset: "a" }, { asset: "b" }], ...o }] });
  it("accepts 1 to 5 layers with defaults, and refuses none, six, and bad ids or enter styles", () => {
    const ok = validateScenes(scene());
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.doc.scenes[0]).toMatchObject({ backing: true, captionZone: "lower_safe", layers: [{ enter: "pop", delayMs: 250 }, { enter: "pop", delayMs: 250 }] });
    expect(validateScenes(scene({ layers: [] })).ok).toBe(false);
    expect(validateScenes(scene({ layers: Array.from({ length: 6 }, (_, i) => ({ asset: `a${i}` })) })).ok).toBe(false);
    expect(validateScenes(scene({ layers: [{ asset: "http://x/y.png" }] })).ok).toBe(false);
    expect(validateScenes(scene({ layers: [{ asset: "a", enter: "spin" }] })).ok).toBe(false);
  });
});

import { buildSceneDoc } from "@/server/core/scene-build";

describe("Build with linked cut-outs", () => {
  const A = "cut_a1";
  const B = "cut_b2";
  const P = "pic_p3";
  const beat = { id: "hook", text: "A kettle, a cup and a spoon on the table." };
  // The model only fills the fixed picture ids: it is never asked to pick the kind or the pictures.
  const answer = (kind: string, ids: string[]) =>
    JSON.stringify({ version: 1, scenes: [{ id: "s1", beat: "hook", kind, startMs: 0, durationMs: 3000, ...(kind === "cutout_stack" ? { layers: ids.map((asset) => ({ asset })) } : { tiles: ids.map((asset) => ({ asset })), layout: "grid2" }) }] });

  it("a beat whose pictures are all cut-outs becomes a cut-out stack with exactly those ids in order, and the prompt says so", async () => {
    const seen: string[] = [];
    const ask = async (m: Array<{ role: string; content: string }>) => (seen.push(m.map((x) => x.content).join("\n")), answer("cutout_stack", [A, B]));
    const doc = (await buildSceneDoc([beat], ask as never, { pictures: { hook: [A, B] }, cutouts: new Set([A, B]) })) as { scenes: Array<{ kind: string; layers: Array<{ asset: string }> }> };
    expect(doc.scenes[0]!.kind).toBe("cutout_stack");
    expect(doc.scenes[0]!.layers.map((l) => l.asset)).toEqual([A, B]);
    expect(seen).toHaveLength(1); // the kind was planned by the app: one fill call, no pick call
    expect(seen[0]).toContain('kind "cutout_stack"');
    expect(seen[0]).toContain(`${A}, ${B}`);
  });
  it("a mix with an ordinary picture stays a collage", async () => {
    const ask = async () => answer("collage", [A, P]);
    const doc = (await buildSceneDoc([beat], ask as never, { pictures: { hook: [A, P] }, cutouts: new Set([A]) })) as { scenes: Array<{ kind: string }> };
    expect(doc.scenes[0]!.kind).toBe("collage");
  });
  it("a model that swaps or invents a picture is sent back, and a scene with the wrong ids never gets through", async () => {
    let calls = 0;
    const ask = async () => (calls++, answer("cutout_stack", [B, A])); // wrong order every time
    await expect(buildSceneDoc([beat], ask as never, { pictures: { hook: [A, B] }, cutouts: new Set([A, B]) })).rejects.toThrow(/scenes_invalid/);
    expect(calls).toBeGreaterThan(1); // it was asked again with the errors before giving up
  });
});
