import { describe, expect, it } from "vitest";
import { stageJobId } from "@/server/core/job-id";

describe("stageJobId", () => {
  const id = "0192f0c4-7a1b-7c3d-8e9f-0123456789ab";

  it("has_the_documented_colon_free_shape", () => {
    expect(stageJobId(id, 3, 7)).toBe(`stage.${id}.3.7`);
    expect(stageJobId(id, 3, 7)).not.toContain(":");
  });

  it("is_unique_per_id_fence_and_attempt", () => {
    const other = "0192f0c4-7a1b-7c3d-8e9f-0123456789ac";
    const ids = new Set<string>();
    for (const sid of [id, other]) for (let f = 0; f < 4; f++) for (let a = 0; a < 4; a++) ids.add(stageJobId(sid, f, a));
    expect(ids.size).toBe(2 * 4 * 4);
  });

  it("rejects_values_that_could_collide_or_break_bullmq", () => {
    expect(() => stageJobId("a:b", 1, 0)).toThrow(RangeError);
    expect(() => stageJobId("a.b", 1, 0)).toThrow(RangeError);
    expect(() => stageJobId("", 1, 0)).toThrow(RangeError);
    for (const bad of [-1, 1.5, Number.NaN, Infinity]) {
      expect(() => stageJobId(id, bad, 0)).toThrow(RangeError);
      expect(() => stageJobId(id, 0, bad)).toThrow(RangeError);
    }
  });
});
