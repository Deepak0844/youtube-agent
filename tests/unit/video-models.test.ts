import { describe, expect, it } from "vitest";
import { isVideoModel, isVideoProvider, VIDEO_MODEL_IDS } from "@/server/core/video-models";
import { KLING_MODELS } from "@/server/providers/video/kling";
import { SEEDANCE_MODELS } from "@/server/providers/video/seedance";
import { VEO_MODELS } from "@/server/providers/video/veo";

describe("the model list the Providers page offers", () => {
  it("is exactly what each adapter can run, so the two cannot drift apart", () => {
    expect([...VIDEO_MODEL_IDS.seedance_video!].sort()).toEqual(Object.keys(SEEDANCE_MODELS).sort());
    expect([...VIDEO_MODEL_IDS.kling_video!].sort()).toEqual(Object.keys(KLING_MODELS).sort());
    expect([...VIDEO_MODEL_IDS.veo_video!].sort()).toEqual(Object.keys(VEO_MODELS).sort());
  });
  it("accepts a real pair and refuses another provider's model, unknown names and prototype names", () => {
    expect(isVideoModel("kling_video", "kling-4.0")).toBe(true);
    expect(isVideoModel("kling_video", "veo-3.1-generate-001")).toBe(false);
    expect(isVideoModel("seedance_video", "")).toBe(false);
    for (const p of ["constructor", "__proto__", "toString", "nope"]) {
      expect(isVideoProvider(p)).toBe(false);
      expect(isVideoModel(p, "x")).toBe(false);
    }
  });
});
