import { readFileSync } from "node:fs";
import path from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("remotion", () => ({
  AbsoluteFill: (p: { children?: React.ReactNode }) => <div data-fill>{p.children}</div>,
  useCurrentFrame: () => 0,
  useVideoConfig: () => ({ fps: 30, width: 1080, height: 1920, durationInFrames: 90 }),
  delayRender: () => 1,
  continueRender: () => undefined,
}));

import { ToonContext, type ToonInput } from "../../remotion/kit/toon/context";
import { CORE_CSS } from "../../remotion/kit/toon/css";
import { createToonRuntime } from "../../remotion/kit/toon/runtime";
import { Scene } from "../../remotion/kit/toon/core";
import { ToonFilm } from "../../remotion/kit/toon/Stage";
import { resolveMark, type ToonTimeline } from "../../remotion/kit/toon/time";

const root = path.resolve(__dirname, "../..");
const tl: ToonTimeline = {
  beats: [
    { startS: 0.1, endS: 2.8, cap: "*UPI* is fast" },
    { startS: 3, endS: 5.4, cap: null },
  ],
  scenes: [
    { id: "hook", startS: 0, endS: 2.9 },
    { id: "big", startS: 2.9, endS: 6 },
  ],
};

describe("cartoon-shorts runtime", () => {
  it("the css string is the upstream core.css", () => {
    expect(CORE_CSS).toBe(readFileSync(path.join(root, "remotion/kit/toon/upstream/core.css"), "utf8"));
  });
  it("upstream time marks agree with the kit's resolveMark", () => {
    const rt = createToonRuntime(tl, {} as Document);
    for (const m of ["B0", "B1e", "B1%50", "B0+.3", "B1-.5", "hook", "hooke", "big+.4", "S1", "L1", 1.25, "2.5"]) {
      expect(rt.short.T(m), String(m)).toBeCloseTo(resolveMark(typeof m === "string" ? m.replace(/^L/, "B") : m, tl), 9);
    }
    expect(() => rt.short.T("B9")).toThrow();
  });
  it("draws the five layers and each scene once", () => {
    const input: ToonInput = { timeline: tl, cast: [], orientation: "portrait" };
    const html = renderToStaticMarkup(
      <ToonContext.Provider value={input}>
        <ToonFilm>
          <Scene id="hook" tr="cut" />
          <Scene id="big" />
        </ToonFilm>
      </ToonContext.Provider>,
    );
    for (const id of ["v", "world", "flash", "vig", "grain", "cap"]) expect(html).toContain(`id="${id}"`);
    expect(html.match(/class="scene"/g)).toHaveLength(2);
    expect(html).toContain('data-scene="hook"');
    expect(html).toContain('data-tr="cut"');
    expect(html).toContain('viewBox="0 0 1080 1920"');
    expect(html).toContain("Noto Sans Devanagari");
  });
  it("the film's own scene windows are made from beat marks, and a bad mark is refused plainly", () => {
    const input: ToonInput = { timeline: { beats: tl.beats, scenes: [] }, cast: [], orientation: "portrait" };
    const ok = renderToStaticMarkup(
      <ToonContext.Provider value={input}>
        <ToonFilm scenes={[{ id: "hook", from: "B0", to: "B1" }, { id: "big", from: "B1", to: "B1e" }]}>
          <Scene id="hook" />
        </ToonFilm>
      </ToonContext.Provider>,
    );
    expect(ok).toContain('data-scene="hook"');
    expect(() =>
      renderToStaticMarkup(
        <ToonContext.Provider value={input}>
          <ToonFilm scenes={[{ id: "hook", from: "B0", to: "B9" }]} />
        </ToonContext.Provider>,
      ),
    ).toThrow("no beat B9 (beats: 2)");
  });
  it("a landscape film uses a 1920x1080 stage", () => {
    const html = renderToStaticMarkup(
      <ToonContext.Provider value={{ timeline: tl, cast: [], orientation: "landscape" }}>
        <ToonFilm>
          <Scene id="hook" />
        </ToonFilm>
      </ToonContext.Provider>,
    );
    expect(html).toContain('viewBox="0 0 1920 1080"');
  });
});
