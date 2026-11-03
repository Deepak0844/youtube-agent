import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { clipAnswer, makeProbePng, visionOk } from "@/server/core/vision-probe";

describe("visionOk", () => {
  it("passes when red and a shape are named", () => {
    expect(visionOk("Red square, white circle inside")).toBe(true);
    expect(visionOk("THE SQUARE IS RED")).toBe(true);
  });
  it("fails when the answer looks wrong", () => {
    expect(visionOk("Blue square with a triangle")).toBe(false);
    expect(visionOk("It is red")).toBe(false);
    expect(visionOk("a square")).toBe(false);
    expect(visionOk("reddish squares")).toBe(false);
    expect(visionOk("")).toBe(false);
  });
});

describe("clipAnswer", () => {
  it("caps at 120 chars and strips markup and control characters", () => {
    expect(clipAnswer("x".repeat(500)).length).toBe(120);
    expect(clipAnswer("<b>hi</b>\n\u0000there")).not.toMatch(/[<>\u0000\n]/);
  });
});

describe("makeProbePng", () => {
  it("is a valid 64x64 RGB PNG with a red corner and a white centre", () => {
    const p = makeProbePng();
    expect(p.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    expect(p.readUInt32BE(16)).toBe(64);
    expect(p.readUInt32BE(20)).toBe(64);
    const idatLen = p.readUInt32BE(33);
    const raw = inflateSync(p.subarray(41, 41 + idatLen));
    expect(raw.length).toBe(64 * 193);
    expect([...raw.subarray(1, 4)]).toEqual([255, 0, 0]);
    const mid = 32 * 193 + 1 + 32 * 3;
    expect([...raw.subarray(mid, mid + 3)]).toEqual([255, 255, 255]);
  });
});
