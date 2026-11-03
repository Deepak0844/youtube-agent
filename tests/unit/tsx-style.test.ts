import { readdirSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { PRESETS, STYLE_IDS } from "../../remotion/kit/presets";
import { COLOR_KEYS, contrast, DEFAULT_TSX_STYLE, getActiveStyle, setActiveStyle, tsxStyleOf } from "../../remotion/kit/tsxlib/styledata";
import { FONTS, MOTION, PACE, PALETTE, safeColor } from "../../remotion/kit/tsxlib/util";
import { captionAt } from "../../remotion/kit/tsx-caption-page";
import { expectedInputHash, type PipelineView } from "@/server/core/pipeline-plan";
import { styleReviewLine, tsxStyleBlock } from "@/server/core/tsx-prompt-style";
import { reviewUserText } from "@/server/core/frame-review";
import { tsxUserPrompt } from "@/server/core/tsx-prompt";

const FONT_FILES = readdirSync("infra/render/fonts").filter((f) => f.endsWith(".ttf")).map((f) => f.split("-")[0]!.toLowerCase());
const hasFont = (family: string) => FONT_FILES.includes(family.replace(/\s+/g, "").toLowerCase());

afterEach(() => setActiveStyle(DEFAULT_TSX_STYLE));

describe.each([...STYLE_IDS])("tsx style %s", (id) => {
  const s = tsxStyleOf(id);
  const p = PRESETS[id];
  it("uses the real sheet palette, with text readable on the page (>= 4.5:1)", () => {
    expect(s.colors.bg.toLowerCase()).toBe(p.sheet![0]!.toLowerCase());
    const allowed = [...p.sheet!, p.palette.text].map((c) => c.toLowerCase());
    for (const k of ["text", "accent", "accent2", "accent3"] as const) expect(allowed, `${id} ${k}`).toContain(s.colors[k].toLowerCase());
    expect(contrast(s.colors.text, s.colors.bg)).toBeGreaterThanOrEqual(4.5);
  });
  it("fonts are installed in the render image", () => {
    for (const f of [p.fonts.heading, p.fonts.body, p.fonts.mono ?? "JetBrains Mono"]) expect(hasFont(f), f).toBe(true);
  });
  it("the prompt block names the palette, fonts, motion, pace, rules and the avoid list", () => {
    const b = tsxStyleBlock(id);
    for (const k of COLOR_KEYS) expect(b).toContain(`PALETTE.${k} ${s.colors[k]}`);
    expect(b).toContain(p.fonts.heading);
    expect(b).toContain(`MOTION.frames = ${s.motion.frames}`);
    expect(b).toContain(`PACE.min = ${s.pace.min}`);
    for (const a of p.antiPatterns) expect(b).toContain(a);
    expect(b.length).toBeLessThan(1900);
    expect(styleReviewLine(id)).toContain(p.label);
  });
  it("PALETTE, FONTS, MOTION and PACE follow the active style", () => {
    setActiveStyle(id);
    expect(PALETTE.bg).toBe(s.colors.bg);
    expect(PALETTE.accent).toBe(s.colors.accent);
    expect(FONTS.display).toContain(p.fonts.heading);
    expect(MOTION.damping).toBe(s.motion.damping);
    expect(PACE.max).toBe(p.pacing.maxHoldFrames);
    expect(safeColor("accent", "#000000")).toBe(s.colors.accent);
  });
});

describe("style switching", () => {
  it("unknown or missing ids are AI Studio; legacy ids are not styles of a code scene", () => {
    for (const bad of [undefined, null, "", "nope", "legacy_default", "__proto__", 7]) expect(tsxStyleOf(bad).id).toBe("ai_studio");
    expect(setActiveStyle("minimal_diagram").id).toBe("minimal_diagram");
    expect(getActiveStyle().light).toBe(true);
    expect(PALETTE.indigo).toBe("#6366F1"); // fixed brand names do not move
  });
  it("the three light styles are light and the rest dark", () => {
    const light = STYLE_IDS.filter((i) => tsxStyleOf(i).light);
    expect(light).toEqual(["clean_professional", "minimal_diagram", "premium_editorial"]);
  });
});

describe("prompt and review", () => {
  const task = { topic: "t", beats: [{ id: "b1", text: "hello there" }], words: [], narrationS: 3 };
  it("the user prompt carries the chosen style block; no style means AI Studio", () => {
    expect(tsxUserPrompt({ ...task, style: "paper_cutout" })).toContain("STYLE: Paper Cutout");
    expect(tsxUserPrompt(task)).toContain("STYLE: AI Studio");
  });
  it("the frame review text names the style and its avoid list", () => {
    const t = reviewUserText([{ frame: 1 }], [], "kinetic_type");
    expect(t).toContain("Kinetic Type");
    expect(t).toContain("small text");
    expect(reviewUserText([{ frame: 1 }], [])).not.toContain("style");
  });
});

describe("caption paging", () => {
  it("takes the words per page of the style", () => {
    const w = [0, 1, 2, 3].map((i) => ({ word: `w${i}`, startS: i * 0.2, endS: i * 0.2 + 0.15 }));
    expect(captionAt(w, 0.01, 1)!.words).toEqual(["w0"]);
    expect(captionAt(w, 0.01)!.words).toEqual(["w0", "w1", "w2"]);
  });
});

describe("hash", () => {
  const view: PipelineView = { kind: "tsx", format: "short", flags: { requireEvidence: false, paidGeneration: false }, paramsHash: "p", feedback: null, content: {}, runs: {}, approved: new Set() };
  it("tsx_author includes the style only when chosen; other stages are unchanged", () => {
    expect(expectedInputHash({ ...view, style: { style: null, captionStyle: null } }, "tsx_author", "x")).toBe(expectedInputHash(view, "tsx_author", "x"));
    const s = { ...view, style: { style: "flat_motion", captionStyle: null } };
    expect(expectedInputHash(s, "tsx_author", "x")).not.toBe(expectedInputHash(view, "tsx_author", "x"));
    for (const st of ["draft", "voice"] as const) expect(expectedInputHash(s, st, "x")).toBe(expectedInputHash(view, st, "x"));
  });
});
