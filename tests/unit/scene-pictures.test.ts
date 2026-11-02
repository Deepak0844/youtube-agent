import { describe, expect, it } from "vitest";
import { buildSceneDoc, checkPictureIds, planPictureBeat } from "@/server/core/scene-build";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const ids = (n: number) => Array.from({ length: n }, (_, i) => `00000000-0000-4000-8000-00000000000${i}`);

describe("planPictureBeat", () => {
  it("one picture -> story_kenburns", () => expect(planPictureBeat([A])).toEqual({ kind: "story_kenburns", assets: [A] }));
  it("2-6 pictures -> collage in order", () => expect(planPictureBeat(ids(6))).toEqual({ kind: "collage", assets: ids(6) }));
  it("more than 6 are cut to 6", () => expect(planPictureBeat(ids(9))?.assets).toEqual(ids(6)));
  it("none -> null (model picks)", () => expect(planPictureBeat([])).toBeNull());
});

describe("checkPictureIds", () => {
  it("accepts the exact id", () => expect(checkPictureIds({ kind: "story_kenburns", image: A }, [A])).toEqual([]));
  it("rejects a foreign id", () => expect(checkPictureIds({ kind: "story_kenburns", image: B }, [A])).toHaveLength(1));
  it("collage must keep order", () => {
    const t = (...a: string[]) => ({ kind: "collage", tiles: a.map((asset) => ({ asset })) });
    expect(checkPictureIds(t(A, B), [A, B])).toEqual([]);
    expect(checkPictureIds(t(B, A), [A, B])).toHaveLength(1);
    expect(checkPictureIds(t(A), [A, B])).toHaveLength(1);
  });
});

describe("buildSceneDoc with pictures", () => {
  const kb = { id: "s1", kind: "story_kenburns", beat: "b1", startMs: 0, durationMs: 3000, image: A, caption: "Cats" };
  it("skips the pick call for a picture beat and tells the model the ids", async () => {
    const prompts: string[] = [];
    const ask = async (m: Array<{ content: string }>) => (prompts.push(m[0]!.content), JSON.stringify({ version: 1, scenes: [kb] }));
    const doc = await buildSceneDoc([{ id: "b1", text: "Cats are small.", visual: "a cat" }], ask as never, { pictures: { b1: [A] }, language: "en" });
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain(A);
    expect(doc.scenes[0]).toMatchObject({ kind: "story_kenburns", image: A, beat: "b1" });
  });
  it("retries when the model uses another id", async () => {
    const answers = [{ ...kb, image: B }, kb].map((s) => JSON.stringify({ version: 1, scenes: [s] }));
    let n = 0;
    const doc = await buildSceneDoc([{ id: "b1", text: "Cats." }], (async () => answers[n++]!) as never, { pictures: { b1: [A] } });
    expect(n).toBe(2);
    expect(doc.scenes[0]).toMatchObject({ image: A });
  });
});
