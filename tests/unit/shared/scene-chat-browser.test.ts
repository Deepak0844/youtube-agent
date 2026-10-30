import { describe, expect, it } from "vitest";
import { validateScenes } from "@/shared/scene";
import { windowOpacity } from "../../../remotion/kit/helpers";

const doc = (s: object) => ({ version: 1, scenes: [s] });
const b = { id: "s1", beat: "b1", startMs: 0, durationMs: 3000 };
const chat = {
  ...b,
  kind: "chat_thread",
  messages: [{ from: "user", text: "hi" }],
};
const web = {
  ...b,
  kind: "browser",
  title: "Pricing",
  url: "example.com/pricing",
  blocks: [
    { type: "heading", text: "Plans" },
    { type: "text", text: "Free forever" },
    { type: "image", asset: "img_ab12" },
  ],
};
const errs = (s: object) => {
  const r = validateScenes(doc(s));
  return r.ok ? [] : r.errors;
};

describe("chat_thread window", () => {
  it("accepts a bounded windowSize and works without it", () => {
    expect(validateScenes(doc(chat)).ok).toBe(true);
    expect(validateScenes(doc({ ...chat, windowSize: 3 })).ok).toBe(true);
  });
  it("rejects windowSize out of range", () => {
    expect(errs({ ...chat, windowSize: 1 })[0]).toContain("windowSize");
    expect(errs({ ...chat, windowSize: 7 })[0]).toContain("windowSize");
    expect(errs({ ...chat, windowSize: 2.5 })[0]).toContain("windowSize");
  });
  it("windowOpacity: visible until pushed out, then fades to 0", () => {
    // message 0, new one every 30 frames, window of 2: leaves when message 2 appears (frame 60)
    expect(windowOpacity(59, 30, 0, 2, 10)).toBe(1);
    expect(windowOpacity(65, 30, 0, 2, 10)).toBe(0.5);
    expect(windowOpacity(70, 30, 0, 2, 10)).toBe(0);
    expect(windowOpacity(0, 30, 0, 99, 10)).toBe(1);
  });
});

describe("browser kind", () => {
  it("accepts a valid page", () =>
    expect(validateScenes(doc(web)).ok).toBe(true));
  it("rejects empty blocks and too many blocks", () => {
    expect(errs({ ...web, blocks: [] })[0]).toContain("blocks");
    expect(
      errs({ ...web, blocks: Array(7).fill({ type: "text", text: "x" }) })[0],
    ).toContain("at most 6");
  });
  it("rejects image blocks that use a URL instead of an asset id", () => {
    expect(
      errs({
        ...web,
        blocks: [{ type: "image", asset: "https://x.com/a.png" }],
      })[0],
    ).toContain("asset id");
  });
  it("rejects overlong title and url, and unknown block type", () => {
    expect(errs({ ...web, title: "x".repeat(41) })[0]).toContain("title");
    expect(errs({ ...web, url: "x".repeat(61) })[0]).toContain("url");
    expect(
      errs({ ...web, blocks: [{ type: "video", text: "x" }] }).length,
    ).toBeGreaterThan(0);
  });
});
