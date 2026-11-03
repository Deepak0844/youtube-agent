import { readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { contrast } from "../../remotion/kit/look";
import { captionStyleOf, CAPTION_STYLES, DEFAULT_STYLE, LEGACY_STYLE_IDS, PRESETS, STYLE_IDS, pageWords, presetOf, styleGuidance, styleHashParts } from "../../remotion/kit/presets";
import { defaultTheme } from "../../remotion/kit/theme";
import { TRANSITION_FRAMES, type CaptionWord } from "../../remotion/kit/timeline";
import { expectedInputHash, type PipelineView } from "@/server/core/pipeline-plan";
import { slideshowRisk } from "@/shared/scene/slideshow";
import { buildVideoProps } from "@/shared/scene/video-props";

const HEX = /^#[0-9a-f]{6}$/i;
const w = (word: string, startS: number, endS = startS + 0.3): CaptionWord => ({ word, startS, endS });

// Families the render image carries: the file names in infra/render/fonts, first word(s) up to "-". Static files add their family name.
const FONT_FILES = readdirSync("infra/render/fonts").filter((f) => f.endsWith(".ttf")).map((f) => f.split("-")[0]!.toLowerCase());
const hasFont = (family: string) => FONT_FILES.includes(family.replace(/\s+/g, "").toLowerCase());

describe("preset shape", () => {
  it("offers exactly the ten styles, and the picker never lists a legacy one", () => {
    expect([...STYLE_IDS]).toEqual(["clean_professional", "flat_motion", "minimal_diagram", "premium_editorial", "storybook_calm", "paper_cutout", "kinetic_type", "retention_shorts", "wrapped_stats", "ai_studio"]);
    for (const id of LEGACY_STYLE_IDS) expect(STYLE_IDS as readonly string[]).not.toContain(id);
  });
  it.each([...STYLE_IDS, ...LEGACY_STYLE_IDS])("%s has valid colours, readable text, sane numbers and fonts that ship", (id) => {
    const p = PRESETS[id];
    expect(p.id).toBe(id === "clean_pro" ? "legacy_default" : id);
    for (const c of [p.palette.bg, p.palette.surface, p.palette.text, p.palette.muted, p.palette.accent, ...(p.palette.accent2 ? [p.palette.accent2] : []), ...p.palette.chart, ...(p.sheet ?? [])]) expect(c).toMatch(HEX);
    expect(contrast(p.palette.text, p.palette.bg)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(p.palette.text, p.palette.surface)).toBeGreaterThanOrEqual(4.5);
    if (p.look) {
      for (const bg of [p.look.from, p.look.to]) expect(contrast("#f2f4f8", bg)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(p.look.accent, p.look.from)).toBeGreaterThanOrEqual(4.5);
    }
    expect(p.pacing.minHoldFrames).toBeLessThan(p.pacing.maxHoldFrames);
    expect(p.motion.transitionFrames).toBeGreaterThan(0);
    expect(p.label && p.mood).toBeTruthy();
    for (const f of [p.fonts.heading, p.fonts.body, p.fonts.mono, p.captions.font].filter((x): x is string => !!x)) expect(hasFont(f), f).toBe(true);
  });
  it("every new style has picker copy, the approved palette and a caption colour that reads", () => {
    for (const id of STYLE_IDS) {
      const p = PRESETS[id];
      expect(p.bestFor && p.sheet?.length).toBeTruthy();
      expect(p.antiPatterns.length).toBeGreaterThan(0);
      expect(styleGuidance(id)).toMatch(/Never:[\s\S]*Pace:/);
    }
    expect(contrast(PRESETS.clean_professional.captions.textColor!, "#f3f4f6")).toBeGreaterThanOrEqual(4.5);
  });
  it("paper cutout: grain, boil, tags, hard cuts; kinetic type: kinetic captions; retention: spring 260/9", () => {
    expect(PRESETS.paper_cutout.fx).toMatchObject({ grain: true, boilBanner: true });
    expect(PRESETS.paper_cutout.captions.layout).toBe("tags");
    expect(PRESETS.paper_cutout.motion.transitionFrames).toBeLessThanOrEqual(5);
    expect(PRESETS.kinetic_type.captions.layout).toBe("kinetic");
    expect(PRESETS.retention_shorts.motion).toMatchObject({ kind: "spring", stiffness: 260, damping: 9 });
    expect(PRESETS.storybook_calm.fx).toMatchObject({ vignette: expect.any(Number), glowDots: true });
  });
  it("old ids still resolve to their old data", () => {
    expect(presetOf("clean_pro")).toBe(PRESETS.legacy_default);
    for (const id of ["neon_flat", "blueprint_whiteboard", "documentary_montage"] as const) expect(presetOf(id).id).toBe(id);
    expect(presetOf("neon_flat").label).toBe("Neon flat");
  });
  it("documentary montage: slow push-in of 4-6%, clip-first, clips 1.2-4 s, text-light prompt", () => {
    const p = PRESETS.documentary_montage;
    expect(p.grade?.pushIn).toBeGreaterThanOrEqual(0.04);
    expect(p.grade?.pushIn).toBeLessThanOrEqual(0.06);
    expect(p.clips).toEqual({ wantAll: true, max: 6 });
    expect(p.pacing).toMatchObject({ minHoldFrames: 36, maxHoldFrames: 120 });
    expect(p.preferKinds).toEqual(["stock_clip", "story_kenburns"]);
    expect(styleGuidance("documentary_montage")).toMatch(/25% of scenes as text cards.*Pace: scenes usually hold 1\.2 to 4\.0 seconds/s);
    expect(PRESETS.legacy_default.grade ?? PRESETS.legacy_default.clips).toBeUndefined();
  });
  it("blueprint whiteboard: dark paper, one accent, slow even holds, 12-frame fade", () => {
    const p = PRESETS.blueprint_whiteboard;
    expect(p.look?.from).toBe("#0c2340");
    expect(p.look?.accent2).toBe(p.look?.accent);
    expect(p.motion).toMatchObject({ kind: "smooth", transitionFrames: 12 });
    expect(p.pacing).toMatchObject({ minHoldFrames: 90, maxHoldFrames: 450 });
    expect(p.preferKinds).toContain("svg_diagram");
    expect(styleGuidance("blueprint_whiteboard")).toMatch(/Prefer these kinds.*svg_diagram.*Pace: scenes usually hold 3\.0 to 15\.0 seconds/s);
  });
  it("punchy captions: 1-3 words, yellow, outlined, about 65% down", () => {
    const c = CAPTION_STYLES.punchy_captions;
    expect(c.wordsPerPage).toBeLessThanOrEqual(3);
    expect(c.activeColor).toMatch(HEX);
    expect(c.outlinePx).toBeGreaterThan(0);
    expect(c.topPct).toBeCloseTo(0.65, 2);
  });
});

describe("default reproduces today", () => {
  const d = PRESETS[DEFAULT_STYLE];
  it("uses the old theme, the seed-picked look, 8-frame fade-up and the pill captions", () => {
    expect(DEFAULT_STYLE).toBe("legacy_default");
    expect(d.palette.bg).toBe(defaultTheme.palette.bg);
    expect(d.palette.text).toBe(defaultTheme.palette.text);
    expect(d.palette.chart).toEqual(defaultTheme.palette.chart);
    expect(d.fonts.body).toBe(defaultTheme.fonts.ui);
    expect(d.look).toBeNull();
    expect(d.motion).toMatchObject({ kind: "smooth", transitionFrames: TRANSITION_FRAMES, rise: 48 });
    expect(d.captions).toMatchObject({ layout: "pill", fontSize: 68 });
  });
  it("missing or unknown ids fall back to it, and add nothing to the Build prompt", () => {
    for (const id of [null, undefined, "", "nope"]) expect(presetOf(id)).toBe(d);
    expect(styleGuidance(null)).toBe("");
    expect(styleGuidance("clean_pro")).toBe("");
    expect(styleGuidance("legacy_default")).toBe("");
    expect(styleGuidance("neon_flat")).toMatch(/Never:/);
  });
  it("the caption layer overrides any preset", () => {
    expect(captionStyleOf(PRESETS.neon_flat, "punchy_captions").layout).toBe("paged");
    expect(captionStyleOf(PRESETS.neon_flat, null).layout).toBe("pill");
  });
});

describe("hashes", () => {
  const view: PipelineView = {
    kind: "scene_kit", format: "short", flags: { requireEvidence: false, paidGeneration: false }, paramsHash: "p", feedback: null,
    content: {}, runs: {}, approved: new Set(),
  };
  it("no style: build and render hashes equal the old ones", () => {
    for (const stage of ["build", "render"] as const) {
      expect(expectedInputHash({ ...view, style: { style: null, captionStyle: null } }, stage, "x")).toBe(expectedInputHash(view, stage, "x"));
    }
    expect(styleHashParts(null, null)).toEqual({});
  });
  it("a chosen style changes build and render only", () => {
    const s = { ...view, style: { style: "neon_flat", captionStyle: null } };
    expect(expectedInputHash(s, "build", "x")).not.toBe(expectedInputHash(view, "build", "x"));
    expect(expectedInputHash(s, "render", "x")).not.toBe(expectedInputHash(view, "render", "x"));
    expect(expectedInputHash(s, "draft", null)).toBe(expectedInputHash(view, "draft", null));
    expect(expectedInputHash(s, "tts", "x")).toBe(expectedInputHash(view, "tts", "x"));
  });
});

describe("render props", () => {
  const scenes = JSON.stringify({ version: 1, scenes: [{ id: "s1", kind: "terminal", beat: "b1", startMs: 0, durationMs: 3000, lines: [{ text: "ls", prompt: "$", output: false }] }] });
  it("carries a known style and drops unknown or null ones", () => {
    const on = buildVideoProps(scenes, { fps: 30, style: "neon_flat", captionStyle: "punchy_captions" });
    expect(on.ok && on.props).toMatchObject({ style: "neon_flat", captionStyle: "punchy_captions" });
    for (const style of [null, undefined, "bogus"]) {
      const off = buildVideoProps(scenes, { fps: 30, style, captionStyle: null });
      expect(off.ok && "style" in off.props).toBe(false);
      expect(off.ok && "captionStyle" in off.props).toBe(false);
    }
  });
});

describe("caption paging", () => {
  it("caps a page at the word limit", () => {
    const ws = ["a", "b", "c", "d", "e", "f", "g"].map((x, i) => w(x, i * 0.3));
    expect(pageWords(ws, 3)).toEqual([[0, 1, 2], [3, 4, 5], [6]]);
    expect(pageWords(ws, 1)).toHaveLength(7);
  });
  it("ends a page at a sentence end or a pause", () => {
    expect(pageWords([w("Hi.", 0), w("there", 0.3), w("you", 0.6)], 3)).toEqual([[0], [1, 2]]);
    expect(pageWords([w("one", 0), w("two", 2), w("three", 2.3)], 3)).toEqual([[0], [1, 2]]);
  });
  it("handles empty input", () => {
    expect(pageWords([], 3)).toEqual([]);
  });
});

describe("slideshowRisk", () => {
  const sc = (kind: string, n: number) => ({ kind, text: `t${n}` });
  it("is quiet for a varied list and for short lists", () => {
    expect(slideshowRisk([sc("chart", 1), sc("terminal", 2), sc("network", 3), sc("orbit", 4), sc("chat_thread", 5)])).toEqual([]);
    expect(slideshowRisk([sc("chart", 1), sc("chart", 2)])).toEqual([]);
  });
  it("flags one kind over 70%", () => {
    const r = slideshowRisk([sc("chart", 1), sc("chart", 2), sc("chart", 3), sc("chart", 4), sc("orbit", 5)]);
    expect(r.some((x) => x.includes('"chart"'))).toBe(true);
  });
  it("flags too many text or number cards", () => {
    const r = slideshowRisk([sc("pause_card", 1), sc("browser", 2), sc("spreadsheet", 3), sc("chart", 4), sc("orbit", 5)]);
    expect(r.some((x) => x.includes("text or number cards"))).toBe(true);
  });
  it("flags repeated descriptions, by scene content or by brief", () => {
    expect(slideshowRisk([{ kind: "chart", t: "same" }, { kind: "chart", t: "same" }, sc("orbit", 3), sc("network", 4)]).some((x) => x.includes("repeat"))).toBe(true);
    expect(slideshowRisk([sc("chart", 1), sc("orbit", 2), sc("network", 3), sc("terminal", 4)], ["a ball", "A ball ", "x", "y"]).some((x) => x.includes("repeat"))).toBe(true);
  });
});
