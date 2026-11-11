import { describe, expect, it } from "vitest";
import { costGateContent } from "@/server/db/queue-data";

describe("costGateContent", () => {
  it("reads the total, the way it is made, the priced items and (AI videos) what each clip asks for", () => {
    const c = costGateContent({
      path: "ai", quote: { micro_usd: "1000000" }, providers_models: { clip: "seedance_video/dreamina-seedance-2-0-fast-260128" },
      items: [{ kind: "clip", provider: "seedance_video/dreamina-seedance-2-0-fast-260128", quoteMicroUsd: 600_000 }, { kind: "clip", provider: "seedance_video/dreamina-seedance-2-0-fast-260128", quoteMicroUsd: 400_000 }],
      shots: [{ beatId: "b1", seconds: 6, prompt: "A fox runs." }, { beatId: "b2", seconds: 4, prompt: "The fox stops." }],
      character: { assetId: "a", storageRef: "assets/a/main.png" },
    });
    expect(c).toEqual({
      kind: "cost", totalMicroUsd: 1_000_000, path: "ai", models: [["clip", "seedance_video/dreamina-seedance-2-0-fast-260128"]],
      items: [{ kind: "clip", provider: "seedance_video/dreamina-seedance-2-0-fast-260128", quoteMicroUsd: 600_000 }, { kind: "clip", provider: "seedance_video/dreamina-seedance-2-0-fast-260128", quoteMicroUsd: 400_000 }],
      shots: [{ beatId: "b1", seconds: 6, prompt: "A fox runs." }, { beatId: "b2", seconds: 4, prompt: "The fox stops." }], character: true,
    });
  });
  it("shows no clip list and no character for an ordinary plan, and survives a body that is not what it should be", () => {
    const plain = costGateContent({ path: "scene_kit", quote: { micro_usd: "2500000" }, providers_models: { image: "fake" }, items: [{ kind: "image", provider: "fake", quoteMicroUsd: 2_500_000 }] });
    expect("shots" in plain).toBe(false);
    expect("character" in plain).toBe(false);
    for (const junk of [null, undefined, 7, "x", [], { shots: "nope", items: 3, quote: 5, providers_models: [] }]) {
      expect(costGateContent(junk)).toMatchObject({ kind: "cost", totalMicroUsd: 0, items: [], models: [] });
    }
    expect(costGateContent({ shots: [{ beatId: 5, seconds: "x", prompt: null }] })).toMatchObject({ shots: [{ beatId: "", seconds: 0, prompt: "" }], character: false });
  });
});
