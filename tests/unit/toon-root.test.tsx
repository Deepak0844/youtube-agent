import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("remotion", () => ({
  AbsoluteFill: (p: { children?: React.ReactNode }) => <div data-fill>{p.children}</div>,
  useCurrentFrame: () => 6,
  useVideoConfig: () => ({ fps: 30, width: 1080, height: 1920, durationInFrames: 90 }),
  delayRender: () => 1,
  continueRender: () => undefined,
}));

import { ToonContext, type ToonInput } from "../../remotion/kit/toon/context";
import { CARTOON_STYLE_IDS, cartoonStyleModule, isCartoonStyle } from "../../remotion/kit/toon/styles";
import { TsxFrame } from "../../remotion/kit/tsx-frame";

const toon: ToonInput = { timeline: { beats: [{ startS: 0, endS: 2, cap: "*UPI* is fast" }], scenes: [{ id: "hook", startS: 0, endS: 3 }] }, cast: [], orientation: "portrait" };
const words = [{ word: "Hello", startS: 0, endS: 1 }];
const Probe: React.FC = () => {
  const t = React.useContext(ToonContext);
  return <p id="probe">{t ? `toon:${t.timeline.beats.length}` : "no-toon"}</p>;
};

describe("cartoon styles in the code-scene root", () => {
  it("knows the five ids and their module", () => {
    expect(CARTOON_STYLE_IDS).toHaveLength(5);
    expect(isCartoonStyle("cartoon_paper")).toBe(true);
    expect(isCartoonStyle("clean_professional")).toBe(false);
    expect(cartoonStyleModule("cartoon_painted")).toBe("painted");
  });
  it("a cartoon style gives the scene the toon input and leaves captions to the film; other styles keep TsxCaptions", () => {
    const cartoon = renderToStaticMarkup(<TsxFrame style="cartoon_comic" toon={toon} captions={words} Scene={Probe} />);
    expect(cartoon).toContain("toon:1");
    expect(cartoon).not.toContain("Hello");
    const plain = renderToStaticMarkup(<TsxFrame style="clean_professional" captions={words} Scene={Probe} />);
    expect(plain).toContain("no-toon");
    expect(plain).toContain("Hello");
  });
  it("a cartoon style without toon input still gets the normal captions", () => {
    expect(renderToStaticMarkup(<TsxFrame style="cartoon_comic" captions={words} Scene={Probe} />)).toContain("Hello");
  });
});
