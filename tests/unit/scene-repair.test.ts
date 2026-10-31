import { describe, expect, it } from "vitest";
import { failingScenes, repairSceneDoc, type SceneBody } from "@/server/core/scene-repair";
import { validateAndCheck } from "@/shared/scene/rules";

const sc = (id: string, beat: string, startMs: number, text: string) => ({ id, kind: "terminal", beat, startMs, durationMs: 3000, lines: [{ text }] });
const body: SceneBody = { version: 1, scenes: [sc("s1", "b1", 0, "ls"), sc("s2", "b2", 3000, "like and subscribe now"), sc("s3", "b3", 6000, "pwd")] };
const o = { beats: ["b1", "b2", "b3"], assets: [] as string[] };
const problems = () => {
  const r = validateAndCheck(body, { beats: o.beats, assetIds: [] });
  return r.ok ? [] : r.errors;
};
const reply = (scene: object) => JSON.stringify({ version: 1, scenes: [scene] });

describe("failingScenes", () => {
  it("maps plain-text problems to zero-based scenes and flags document-level ones", () => {
    expect(failingScenes(["scene 3: x", "scene 2 > lines: y", "document: z"])).toEqual({ indexes: [1, 2], documentLevel: true });
  });
});

describe("repairSceneDoc", () => {
  it("fixes only the failing scene; others stay the same objects; app keeps id/beat/timing", async () => {
    expect(failingScenes(problems()).indexes).toEqual([1]);
    const asked: string[] = [];
    const r = await repairSceneDoc(body, [1], problems(), async (m) => (asked.push(JSON.stringify(m)), reply({ ...sc("zz", "bad", 1, "Two and two"), })), o);
    if (!r.ok) throw new Error(r.errors.join());
    expect(r.changed).toEqual(["s2"]);
    expect(r.body.scenes[0]).toBe(body.scenes[0]);
    expect(r.body.scenes[2]).toBe(body.scenes[2]);
    expect(r.body.scenes[1]).toMatchObject({ id: "s2", beat: "b2", startMs: 3000 });
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain("like and subscribe now");
  });

  it("retries with the problems, then stops at 2 retries; a repeated answer stops early", async () => {
    let n = 0;
    const r = await repairSceneDoc(body, [1], problems(), async () => ["nope", "{}", reply(sc("s2", "b2", 3000, "subscribe"))][n++]!, o);
    expect(r.ok).toBe(false);
    expect(n).toBe(3);
    let m = 0;
    const same = await repairSceneDoc(body, [1], problems(), async () => (m++, reply(sc("s2", "b2", 3000, "subscribe"))), o);
    expect(same.ok).toBe(false);
    expect(m).toBe(2);
  });
});
