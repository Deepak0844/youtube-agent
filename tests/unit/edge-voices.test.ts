import { describe, expect, it } from "vitest";
import { EDGE_ALLOWED, EDGE_VOICES } from "@/server/core/edge-voices";

describe("edge voices", () => {
  it("English defaults to Indian English; every default and the earlier English voice are accepted", () => {
    expect(EDGE_VOICES.en).toBe("en-IN-NeerjaExpressiveNeural");
    for (const v of Object.values(EDGE_VOICES)) expect(EDGE_ALLOWED).toContain(v);
    expect(EDGE_ALLOWED).toContain("en-US-AriaNeural");
  });
});
