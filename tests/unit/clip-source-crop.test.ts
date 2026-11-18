import { describe, expect, it } from "vitest";
import { sourceCaptionCrop } from "@/worker/stages/clips";

describe("sourceCaptionCrop", () => {
  it("crops the burned-in captions of an app-made code-scene source: 10% landscape, the safe zone portrait", () => {
    expect(sourceCaptionCrop({ kind: "tsx", format: "long" })).toBe(0.1);
    expect(sourceCaptionCrop({ kind: "tsx", format: "short" })).toBe(0.22);
  });
  it("leaves other sources alone", () => {
    expect(sourceCaptionCrop({ kind: "scene", format: "short" })).toBeUndefined();
  });
});
