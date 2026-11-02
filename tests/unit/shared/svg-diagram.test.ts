import { describe, expect, it } from "vitest";
import { validateAndCheck } from "@/shared/scene/rules";
import { sampleDoc } from "@/shared/scene/samples";
import { validateScenes } from "@/shared/scene";
import { animAt, drawFrames, parseAnim, sanitizeSvg, stepAt, SVG_EXAMPLE, svgLayoutProblems, SVG_TAGS } from "../../../remotion/kit/svgLogic";

const wrap = (inner: string) => `<svg viewBox="0 0 1000 1000">${inner}</svg>`;
const bad = (svg: string) => {
  const r = sanitizeSvg(svg);
  expect(r.ok).toBe(false);
  return r.ok ? [] : r.problems;
};
const rule = (svg: string) => {
  const r = sanitizeSvg(svg);
  if (!r.ok) throw new Error(r.problems.join(";"));
  return svgLayoutProblems(r.root);
};
const T = (extra = "", at = 'x="100" y="300"') => `<text ${at} font-size="44" fill="#ffffff" ${extra}>Hi</text>`;
// A passing diagram body: 3 animated shapes, 1 static, 2 labels.
const GOOD = `<rect x="100" y="100" width="200" height="100" stroke="#5eead4" data-anim="pop"/><circle cx="500" cy="150" r="40" stroke="#5eead4" data-anim="fade"/><path d="M300 150 H460" stroke="#fff" data-anim="draw"/>${T("", 'x="100" y="400"')}${T("", 'x="100" y="600"')}`;

describe("sanitizeSvg accepts", () => {
  it("the built-in example", () => {
    expect(sanitizeSvg(SVG_EXAMPLE).ok).toBe(true);
    expect(rule(SVG_EXAMPLE)).toEqual([]);
  });
  it("every allowed element", () => {
    const body = `<defs><linearGradient id="a"><stop offset="0" stop-color="#fff"/></linearGradient><radialGradient id="b"><stop offset="1" stop-color="accent"/></radialGradient><marker id="m" markerWidth="6" markerHeight="6" refX="3" refY="3" orient="auto" viewBox="0 0 6 6"><path d="M0 0 L6 3 L0 6 Z" fill="#fff"/></marker></defs><title>t</title><g transform="translate(5 5)"><path d="M0 0L10 10" marker-end="url(#m)"/><rect x="1" y="1" width="2" height="2" fill="url(#a)"/><circle cx="1" cy="1" r="2" fill="url(#b)"/><ellipse cx="1" cy="1" rx="2" ry="3"/><line x1="0" y1="0" x2="5" y2="5"/><polyline points="0,0 5,5"/><polygon points="0,0 5,5 5,0"/><text x="1" y="2">a<tspan font-weight="bold">b</tspan></text></g>`;
    expect(sanitizeSvg(wrap(body)).ok).toBe(true);
    for (const t of SVG_TAGS) expect(["svg", "g", "defs", "path", "rect", "circle", "ellipse", "line", "polyline", "polygon", "text", "tspan", "linearGradient", "radialGradient", "stop", "marker", "title"]).toContain(t);
  });
  it("single-quoted attributes, whitespace, currentColor, tokens and the xmlns", () => {
    expect(sanitizeSvg(`\n <svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1000 1000'>\n<rect x='1' y='1' width='5' height='5' fill='currentColor' stroke='warn'/></svg>\n`).ok).toBe(true);
  });
  it("returns a tree with validated attributes only", () => {
    const r = sanitizeSvg(wrap('<rect x="1" y="2" width="3" height="4"/>'));
    expect(r.ok && r.root.kids).toEqual([{ tag: "rect", attrs: { x: "1", y: "2", width: "3", height: "4" }, kids: [] }]);
  });
  it("non-Latin labels", () => {
    expect(sanitizeSvg(wrap('<text x="1" y="2">नमस्ते</text>')).ok).toBe(true);
  });
});

describe("sanitizeSvg rejects", () => {
  it.each([
    ["script", "<script>alert(1)</script>"],
    ["style", "<style>*{}</style>"],
    ["foreignObject", "<foreignObject><div/></foreignObject>"],
    ["image", '<image x="1"/>'],
    ["use", '<use x="1"/>'],
    ["a", "<a><rect/></a>"],
    ["animate", "<animate/>"],
    ["animateTransform", "<animateTransform/>"],
    ["set", "<set/>"],
    ["upper-case SCRIPT", "<SCRIPT>1</SCRIPT>"],
    ["mixed-case tag", "<Rect x='1'/>"],
    ["lower-cased camel tag", "<lineargradient/>"],
    ["namespaced tag", "<svg:script/>"],
    ["nested svg", "<svg viewBox='0 0 1000 1000'/>"],
  ])("element %s", (_n, inner) => {
    expect(bad(wrap(inner)).join(" ")).toMatch(/not allowed|nested/);
  });
  it.each([
    ["onload", '<rect onload="x()"/>'],
    ["onclick", '<rect onclick="x()"/>'],
    ["ONCLICK", '<rect ONCLICK="x()"/>'],
    ["href", '<rect href="https://x"/>'],
    ["xlink:href", '<rect xlink:href="https://x"/>'],
    ["style attr", '<rect style="fill:red"/>'],
    ["class", '<rect class="a"/>'],
    ["unknown", '<rect filter="x"/>'],
    ["upper-case attr", '<rect X="1"/>'],
    ["clip-path", '<rect clip-path="url(#a)"/>'],
  ])("attribute %s", (_n, inner) => {
    expect(bad(wrap(inner)).join(" ")).toMatch(/not allowed/);
  });
  it("<svg/onload> and other tag-attribute tricks", () => {
    expect(sanitizeSvg("<svg/onload=alert(1)>").ok).toBe(false);
    expect(sanitizeSvg('<svg viewBox="0 0 1000 1000" onload="x()"></svg>').ok).toBe(false);
    expect(sanitizeSvg('<svg viewBox="0 0 1000 1000"><rect x="1"y="2"/></svg>').ok).toBe(false);
    expect(sanitizeSvg('<svg viewBox="0 0 1000 1000"><rect x=1/></svg>').ok).toBe(false);
    expect(sanitizeSvg('<svg viewBox="0 0 1000 1000"><rect x="1" x="2"/></svg>').ok).toBe(false);
    expect(sanitizeSvg('<svg viewBox="0 0 1000 1000"><rect x="1">').ok).toBe(false);
  });
  it("urls, javascript: and data:", () => {
    expect(bad(wrap('<rect fill="url(http://evil/x.svg#a)"/>')).join()).toContain("url(#id)");
    expect(bad(wrap('<rect fill="url(javascript:alert(1))"/>')).join()).toContain("url(#id)");
    expect(bad(wrap('<rect fill="url(data:image/svg+xml,x)"/>')).join()).toContain("url(#id)");
    expect(bad(wrap('<rect fill="URL(#a)"/>')).length).toBeGreaterThan(0);
    expect(bad(wrap('<rect fill="url(#nowhere)"/>')).join()).toContain("does not exist");
    expect(bad(wrap('<stop stop-color="url(#a)"/>')).length).toBeGreaterThan(0);
    expect(bad(wrap('<rect fill="javascript:alert(1)"/>')).length).toBeGreaterThan(0);
    expect(bad(wrap('<rect stroke="data:text/html,x"/>')).length).toBeGreaterThan(0);
    expect(bad(wrap('<path d="M0 0" marker-end="url(https://x)"/>')).length).toBeGreaterThan(0);
  });
  it("colours that are not hex or tokens", () => {
    for (const c of ["red", "rgb(1,2,3)", "#12", "#gggggg", "var(--x)", "inherit"]) expect(bad(wrap(`<rect fill="${c}"/>`)).join()).toContain("not allowed");
  });
  it("entities, comments, DOCTYPE, CDATA, XML declarations, NUL", () => {
    expect(bad(wrap("<text>&lt;script&gt;</text>")).join()).toContain("entities");
    expect(bad(wrap('<rect id="a&#x41;"/>')).join()).toContain("entities");
    expect(bad(wrap("<!-- hi --><rect/>")).join()).toContain("comments");
    expect(bad(wrap("<![CDATA[x]]>")).join()).toContain("CDATA");
    expect(bad(`<!DOCTYPE svg [<!ENTITY x "y">]>${wrap("")}`).join()).toContain("DOCTYPE");
    expect(bad(`<?xml version="1.0"?>${wrap("")}`).join()).toContain("XML declarations");
    expect(sanitizeSvg(wrap("<text>a\0b</text>")).ok).toBe(false);
  });
  it("text outside text elements and stray content", () => {
    expect(bad(wrap("hello")).join()).toContain("text is only allowed");
    expect(bad(`hi${wrap("")}`).join()).toContain("outside");
    expect(bad(`${wrap("")}<rect/>`).join()).toContain("after");
    expect(bad(`${wrap("")}x`).join()).toContain("outside");
    expect(bad("<rect/>").join()).toContain("first element");
    expect(sanitizeSvg("").ok).toBe(false);
    expect(sanitizeSvg(42).ok).toBe(false);
  });
  it("direction overrides and control characters in text", () => {
    expect(sanitizeSvg(wrap("<text>a‮b</text>")).ok).toBe(false);
    expect(sanitizeSvg(wrap("<text>a\u0007b</text>")).ok).toBe(false);
  });
  it("wrong or missing viewBox", () => {
    expect(bad('<svg viewBox="0 0 500 500"></svg>').join()).toContain("viewBox");
    expect(bad("<svg></svg>").join()).toContain("viewBox");
    expect(bad(wrap("").replace("<svg ", '<svg xmlns="http://evil" ')).join()).toContain("xmlns");
  });
  it("oversize: chars, elements, nesting, path, text, text count", () => {
    expect(bad(wrap(`<!--${"x".repeat(6000)}-->`)).join()).toContain("over the 6000");
    expect(bad(wrap("<rect/>".repeat(60))).join()).toContain("more than 60 elements");
    expect(sanitizeSvg(wrap("<rect/>".repeat(59))).ok).toBe(true);
    expect(bad(wrap("<g>".repeat(6) + "</g>".repeat(6))).join()).toContain("nesting");
    expect(sanitizeSvg(wrap("<g>".repeat(5) + "</g>".repeat(5))).ok).toBe(true);
    expect(bad(wrap(`<path d="M0 0${" L1 1".repeat(500)}"/>`)).join()).toContain("2000");
    expect(bad(wrap(`<text>${"a".repeat(41)}</text>`)).join()).toContain("over the 40 cap");
    expect(sanitizeSvg(wrap(`<text>${"a".repeat(40)}</text>`)).ok).toBe(true);
    expect(bad(wrap('<text x="1">a</text>'.repeat(13))).join()).toContain("over the 12 cap");
    expect(bad(wrap(`<title>${"a".repeat(41)}</title>`)).length).toBeGreaterThan(0);
  });
  it("numbers outside -2000..3000 or not plain", () => {
    expect(bad(wrap('<rect x="3001"/>')).length).toBe(1);
    expect(bad(wrap('<rect x="-2001"/>')).length).toBe(1);
    expect(bad(wrap('<rect x="1e9"/>')).length).toBe(1);
    expect(bad(wrap('<rect x="10px"/>')).length).toBe(1);
    expect(bad(wrap('<rect x="calc(1+1)"/>')).length).toBe(1);
    expect(bad(wrap('<rect width="-5"/>')).length).toBe(1);
    expect(bad(wrap('<path d="M0 0 L99999 0"/>')).join()).toContain("outside");
    expect(bad(wrap('<polyline points="0,0 5000,1"/>')).length).toBe(1);
    expect(bad(wrap('<g transform="translate(9999 0)"/>')).length).toBe(1);
    expect(bad(wrap('<rect opacity="2"/>')).length).toBe(1);
    expect(bad(wrap('<rect stroke-width="500"/>')).length).toBe(1);
    expect(sanitizeSvg(wrap('<rect x="3000" y="-2000"/>')).ok).toBe(true);
  });
  it("path data, transform, font and enum values", () => {
    expect(bad(wrap('<path d="L0 0"/>')).join()).toContain("start with M");
    expect(bad(wrap('<path d="M0 0 javascript"/>')).length).toBeGreaterThan(0);
    expect(bad(wrap("<path/>")).join()).toContain("needs d");
    expect(bad(wrap('<g transform="rotate(5) url(x)"/>')).length).toBe(1);
    expect(bad(wrap('<text font-family="Comic Sans">a</text>')).length).toBe(1);
    expect(bad(wrap('<text font-family="x;}body{display:none">a</text>')).length).toBe(1);
    expect(sanitizeSvg(wrap('<text font-family="JetBrains Mono">a</text>')).ok).toBe(true);
    expect(bad(wrap('<rect stroke-linecap="evil"/>')).length).toBe(1);
    expect(bad(wrap('<rect id="1bad"/>')).length).toBe(1);
    expect(bad(wrap('<rect id="a"/><rect id="a"/>')).join()).toContain("duplicate");
  });
  it("animation attributes", () => {
    expect(bad(wrap('<rect data-anim="spin"/>')).length).toBe(1);
    expect(bad(wrap('<rect data-anim="move:5000,0"/>')).length).toBe(1);
    expect(bad(wrap('<rect data-anim="move:1"/>')).length).toBe(1);
    expect(bad(wrap('<defs data-anim="fade"/>')).join()).toContain("cannot animate");
    expect(bad(wrap('<g data-anim="draw"/>')).join()).toContain("draw only works");
    expect(bad(wrap('<text data-anim="draw">a</text>')).length).toBe(1);
    expect(bad(wrap('<rect data-delay="301"/>')).length).toBe(1);
    expect(bad(wrap('<rect data-delay="-1"/>')).length).toBe(1);
    expect(sanitizeSvg(wrap('<g data-anim="move:-50.5,20" data-delay="300"><rect/></g>')).ok).toBe(true);
  });
  it("reports several problems at once (for retry feedback)", () => {
    expect(bad(wrap('<rect fill="red" onclick="x" x="99999"/>')).length).toBe(3);
  });
});

describe("schema and rules", () => {
  const scene = (svg: string, extra: object = {}) => ({ version: 1, scenes: [{ id: "s1", beat: "b1", kind: "svg_diagram", startMs: 0, durationMs: 4000, title: "Flow", svg, ...extra }] });
  it("the sample passes schema and house rules", () => {
    expect(validateScenes(sampleDoc("svg_diagram")).ok).toBe(true);
    expect(validateAndCheck(sampleDoc("svg_diagram")).ok).toBe(true);
  });
  it("schema surfaces sanitizer problems on the svg path", () => {
    const r = validateScenes(scene(wrap("<script/>")));
    expect(!r.ok && r.errors[0]).toContain("scene 1 > svg:");
  });
  it("schema needs a title and bounds steps", () => {
    expect(validateScenes(scene(SVG_EXAMPLE, { title: "" })).ok).toBe(false);
    expect(validateScenes(scene(SVG_EXAMPLE, { steps: [{ at: 1.5 }] })).ok).toBe(false);
    expect(validateScenes(scene(SVG_EXAMPLE, { steps: Array.from({ length: 5 }, () => ({ at: 0.5 })) })).ok).toBe(false);
    expect(validateScenes(scene(SVG_EXAMPLE, { steps: [{ at: 0.5, caption: "Hop" }] })).ok).toBe(true);
  });
  it("a good minimal diagram passes", () => {
    expect(rule(wrap(GOOD))).toEqual([]);
  });
  it("text under 40 is flagged", () => {
    expect(rule(wrap(GOOD.replace('font-size="44" fill="#ffffff"', 'font-size="39" fill="#ffffff"'))).join()).toContain("at least 40");
    expect(rule(wrap(GOOD.replace(/font-size="44"/g, ""))).join()).toContain("missing");
  });
  it("font-size is inherited from a group", () => {
    const g = `<g font-size="44" fill="#fff"><text x="100" y="400">a</text><text x="100" y="600">b</text></g>`;
    expect(rule(wrap(GOOD.replace(/<text.*<\/text>/, g)))).toEqual([]);
  });
  it("out of the safe area is flagged, including the caption zone and move targets", () => {
    expect(rule(wrap(GOOD + '<rect x="100" y="800" width="50" height="50" stroke="#fff"/>')).join()).toContain("safe area");
    expect(rule(wrap(GOOD + '<rect x="0" y="0" width="1000" height="1000" stroke="#fff"/>')).join()).toContain("safe area");
    expect(rule(wrap(GOOD + '<circle cx="500" cy="500" r="20" stroke="#fff" data-anim="move:0,400"/>')).join()).toContain("safe area");
    expect(rule(wrap(GOOD + '<path d="M900 100 L1100 100" stroke="#fff"/>')).join()).toContain("safe area");
    expect(rule(wrap(GOOD + `<text x="900" y="700" font-size="60" fill="#fff">wide label</text>`)).join()).toContain("safe area");
  });
  it("translate is followed, other transforms are skipped", () => {
    expect(rule(wrap(GOOD + '<g transform="translate(0 700)"><rect x="100" y="100" width="50" height="50" stroke="#fff"/></g>')).join()).toContain("safe area");
    expect(rule(wrap(GOOD + '<g transform="scale(0.5)"><rect x="100" y="1400" width="50" height="50" stroke="#fff"/></g>'))).toEqual([]);
  });
  it("needs 3 animated elements and 1 static", () => {
    expect(rule(wrap(GOOD.replace(/ data-anim="draw"/, ""))).join()).toContain("only 2");
    expect(rule(wrap(GOOD.replace(/<text/g, "<text data-anim='fade'"))).join()).toContain("nothing is visible");
  });
  it("needs 2 labels", () => {
    expect(rule(wrap(GOOD.replace(T("", 'x="100" y="600"'), ""))).join()).toContain("at least 2 text labels");
  });
  it("overlapping labels are flagged, moving ones are not", () => {
    expect(rule(wrap(GOOD + T("", 'x="110" y="410"'))).join()).toContain("overlap");
    expect(rule(wrap(GOOD + T('data-anim="move:300,0"', 'x="110" y="410"')).replace(/>$/, ">"))).not.toContain("overlap");
  });
  it("dark colours on the dark background are flagged", () => {
    expect(rule(wrap(GOOD.replace('stroke="#5eead4" data-anim="pop"', 'stroke="#101010" data-anim="pop"'))).join()).toContain("too dark");
    expect(rule(wrap(GOOD.replace(/fill="#ffffff"/g, 'fill="#222"'))).join()).toContain("too dark");
    expect(rule(wrap(GOOD.replace(/ fill="#ffffff"/g, ""))).join()).toContain("no visible fill");
  });
  it("banned wording in labels reaches validateAndCheck", () => {
    const r = validateAndCheck(scene(wrap(GOOD.replace(/>Hi</g, ">Subscribe<"))));
    expect(!r.ok && r.errors.join()).toContain("banned phrase");
  });
  it("problems come back as scene-prefixed retry text", () => {
    const r = validateAndCheck(scene(wrap(GOOD.replace(/font-size="44"/g, 'font-size="20"'))));
    expect(!r.ok && r.errors[0]).toMatch(/^scene 1: .*\[svg-diagram\]\. Fix:/);
  });
});

describe("animation maths", () => {
  const A = (s: string) => parseAnim({ "data-anim": s, "data-delay": "10" });
  it("parses data-anim and data-delay", () => {
    expect(A("move:-5.5,20")).toEqual({ type: "move", dx: -5.5, dy: 20, delay: 10 });
    expect(A("pop")).toEqual({ type: "pop", dx: 0, dy: 0, delay: 10 });
    expect(parseAnim({})).toBeNull();
    expect(parseAnim({ "data-anim": "fade" })?.delay).toBe(0);
  });
  it("draw frames are linear-bound to 21..36", () => {
    expect(drawFrames(0)).toBe(21);
    expect(drawFrames(900)).toBe(36);
    expect(drawFrames(5000)).toBe(36);
    expect(drawFrames(450)).toBeGreaterThan(21);
  });
  it("draw: hidden before delay, linear, done after dur", () => {
    const a = A("draw");
    expect(animAt(a, 10, 1, 30)).toMatchObject({ opacity: 0, draw: 0 });
    expect(animAt(a, 25, 1, 30).draw).toBeCloseTo(0.5);
    expect(animAt(a, 40, 1, 30)).toMatchObject({ opacity: 1, draw: 1 });
    expect(animAt(a, 999, 1, 30).draw).toBe(1);
  });
  it("fade takes 12 frames", () => {
    const a = A("fade");
    expect(animAt(a, 5, 1).opacity).toBe(0);
    expect(animAt(a, 16, 1).opacity).toBeCloseTo(0.5);
    expect(animAt(a, 22, 1).opacity).toBe(1);
  });
  it("pop is hidden then follows the spring", () => {
    const a = A("pop");
    expect(animAt(a, 9, 0.7)).toMatchObject({ opacity: 0, scale: 0 });
    expect(animAt(a, 12, 0.7)).toMatchObject({ opacity: 1, scale: 0.7 });
  });
  it("move eases from 0 to the offset over 30 frames and stays", () => {
    const a = A("move:100,-40");
    expect(animAt(a, 5, 1).opacity).toBe(0);
    expect(animAt(a, 10, 1).opacity).toBe(1);
    expect(Math.abs(animAt(a, 10, 1).dx)).toBe(0);
    expect(animAt(a, 25, 1).dx).toBeCloseTo(50);
    expect(animAt(a, 40, 1)).toMatchObject({ dx: 100, dy: -40 });
    expect(animAt(a, 400, 1).dx).toBe(100);
  });
  it("pulse stays visible and oscillates", () => {
    const a = A("pulse");
    expect(animAt(a, 0, 1)).toMatchObject({ opacity: 1, scale: 1 });
    expect(animAt(a, 10 + 7.5, 1).scale).toBeCloseTo(1.08);
  });
  it("no animation is the resting state", () => {
    expect(animAt(null, 3)).toEqual({ opacity: 1, scale: 1, dx: 0, dy: 0, draw: null });
  });
  it("stepAt picks the latest step reached, in time order", () => {
    const s = [{ at: 0.5 }, { at: 0 }, { at: 0.8 }];
    expect(stepAt(s, -0.1)).toBe(-1);
    expect(stepAt(s, 0)).toBe(1);
    expect(stepAt(s, 0.6)).toBe(0);
    expect(stepAt(s, 1)).toBe(2);
    expect(stepAt([], 0.5)).toBe(-1);
  });
});

describe("sanitizer hardening", () => {
  const ms = (f: () => void) => {
    const t = performance.now();
    f();
    return performance.now() - t;
  };
  it("ReDoS inputs finish fast", () => {
    const n = "1".repeat(25);
    const m = `<g transform="matrix(${[n, n, n, n, n, n].join(" ")} x)"/>`;
    expect(ms(() => sanitizeSvg(wrap(m)))).toBeLessThan(50);
    const big = wrap(`<g transform="translate(${"1".repeat(150)}x)"/>`);
    expect(ms(() => sanitizeSvg(big))).toBeLessThan(50);
    const huge = wrap(`<path d="M${"1".repeat(5900)}x"/>`);
    expect(ms(() => sanitizeSvg(huge))).toBeLessThan(50);
    expect(ms(() => sanitizeSvg(wrap(`<rect x="${"1.".repeat(2900)}x"/>`)))).toBeLessThan(50);
    expect(ms(() => sanitizeSvg(wrap(`<polyline points="${"1 ".repeat(2900)}x"/>`)))).toBeLessThan(50);
  });
  it("transforms still parse", () => {
    expect(sanitizeSvg(wrap('<g transform="translate(5, 5) rotate(45) scale(.5)"/>')).ok).toBe(true);
    expect(sanitizeSvg(wrap('<g transform="translate()"/>')).ok).toBe(false);
    expect(sanitizeSvg(wrap('<g transform="translate(1 2 3 4 5 6 7)"/>')).ok).toBe(false);
  });
  it("inherited object keys never throw", () => {
    for (const k of ["constructor", "__proto__", "toString", "hasOwnProperty", "valueOf"]) {
      expect(() => sanitizeSvg(wrap(`<rect ${k}="x"/>`))).not.toThrow();
      expect(sanitizeSvg(wrap(`<rect ${k}="x"/>`)).ok).toBe(false);
    }
    expect(sanitizeSvg(wrap("<constructor/>")).ok).toBe(false);
  });
  it("long tag names are cut in feedback", () => {
    expect(bad(wrap(`<${"a".repeat(500)}/>`)).join().length).toBeLessThan(300);
  });
});
