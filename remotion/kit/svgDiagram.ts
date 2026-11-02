// svg_diagram: strict allow-list sanitizer, layout checks and animation maths. Pure (no imports), so the app, the tests and the renderer share it.
// The model writes SVG as DATA. Nothing here trusts it: the string is parsed by a small strict parser into a tree of allow-listed
// elements and attributes with validated values. Anything else is REJECTED with a plain problem (never silently stripped), and the
// renderer builds React elements from that tree only. The raw string never reaches the DOM.

export const SVG_LIMITS = { chars: 6000, elements: 60, depth: 6, d: 2000, points: 1000, text: 40, texts: 12, min: -2000, max: 3000, minFont: 40 } as const;
export const SVG_VIEW = 1000;
/** Content must sit in here (viewBox units): the bottom 22% stays free for captions. */
export const SVG_SAFE = { x0: 30, y0: 30, x1: 970, y1: 780 } as const;

export const SVG_TAGS = ["svg", "g", "defs", "path", "rect", "circle", "ellipse", "line", "polyline", "polygon", "text", "tspan", "linearGradient", "radialGradient", "stop", "marker", "title"] as const;
const TAGS = new Set<string>(SVG_TAGS);
const SHAPES = new Set(["path", "rect", "circle", "ellipse", "line", "polyline", "polygon"]);
const ANIM_TAGS = new Set([...SHAPES, "g", "text"]);
const TEXT_TAGS = new Set(["text", "tspan", "title"]);

/** Colour names a diagram may use besides hex; the kit maps them to the theme. currentColor means the accent. */
export const SVG_COLOR_TOKENS = ["accent", "text", "muted", "ok", "warn", "blue", "surface"] as const;
const TOKENS = new Set<string>(SVG_COLOR_TOKENS);
export const SVG_FONTS = ["Inter", "JetBrains Mono", "sans-serif", "monospace"] as const;

export type SvgNode = { tag: string; attrs: Record<string, string>; kids: (SvgNode | string)[] };
export type SvgResult = { ok: true; root: SvgNode } | { ok: false; problems: string[] };

// ---- value checks ----
const NUM = "-?(?:\\d+\\.?\\d*|\\.\\d+)(?:[eE][-+]?\\d+)?";
const NUM_RE = new RegExp(`^${NUM}$`);
const HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const ID = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;
const URL_REF = /^url\(#([A-Za-z][A-Za-z0-9_-]{0,31})\)$/;
const BAD_TEXT = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f‪-‮⁦-⁩﻿]/;

const inRange = (n: number) => Number.isFinite(n) && n >= SVG_LIMITS.min && n <= SVG_LIMITS.max;
const GEOM = new Set(["x", "y", "cx", "cy", "x1", "y1", "x2", "y2", "fx", "fy", "refX", "refY"]);
const SIZE = new Set(["r", "rx", "ry", "width", "height", "markerWidth", "markerHeight"]);
const UNIT = new Set(["opacity", "fill-opacity", "stroke-opacity", "stop-opacity", "offset"]);
const SIMPLE_ENUM: Record<string, readonly string[]> = {
  "stroke-linecap": ["butt", "round", "square"],
  "stroke-linejoin": ["miter", "round", "bevel"],
  "text-anchor": ["start", "middle", "end"],
  "dominant-baseline": ["auto", "middle", "central", "hanging"],
  gradientUnits: ["objectBoundingBox", "userSpaceOnUse"],
  markerUnits: ["strokeWidth", "userSpaceOnUse"],
};
const FORBIDDEN_HINT: [RegExp, string][] = [
  [/^on/i, "event handler attributes (on*) are not allowed"],
  [/^(xlink:)?href$/i, "href links are not allowed"],
  [/^style$/i, "style attributes are not allowed: use fill, stroke, font-size... attributes"],
  [/^class$/i, "class is not allowed"],
];

function numList(v: string, max: number): string | null {
  if (v.length > max) return `is longer than ${max} characters`;
  if (!/^[-+0-9eE.,\s]+$/.test(v)) return "may only contain numbers";
  for (const t of v.match(new RegExp(NUM, "g")) ?? []) if (!inRange(Number(t))) return `has a number outside ${SVG_LIMITS.min}..${SVG_LIMITS.max}`;
  return null;
}
function pathData(v: string): string | null {
  if (v.length > SVG_LIMITS.d) return `is longer than ${SVG_LIMITS.d} characters`;
  if (!/^[MmLlHhVvCcSsQqTtAaZz0-9eE.,\s+-]+$/.test(v)) return "may only contain path commands and numbers";
  if (!/^\s*[Mm]/.test(v)) return "must start with M";
  return numList(v.replace(/[A-Za-z]/g, (c) => (c === "e" || c === "E" ? c : " ")), SVG_LIMITS.d);
}
function transform(v: string): string | null {
  if (v.length > 200) return "is too long";
  const m = new RegExp(`^(?:\\s*(?:translate|scale|rotate|skewX|skewY|matrix)\\(\\s*${NUM}(?:\\s*[ ,]\\s*${NUM}){0,5}\\s*\\))+\\s*$`).test(v);
  if (!m) return "must be translate(), scale(), rotate(), skewX(), skewY() or matrix() with plain numbers";
  return numList(v.replace(/[a-zA-Z()]/g, (c) => (c === "e" || c === "E" ? c : " ")), 200);
}
/** "none", currentColor, a token, hex, or (paint) url(#id). Returns a problem or null. */
function color(v: string, paint: boolean, refs: string[]): string | null {
  if (v === "none" || v === "currentColor" || TOKENS.has(v) || HEX.test(v)) return null;
  const u = URL_REF.exec(v);
  if (paint && u) {
    refs.push(u[1]!);
    return null;
  }
  if (/url\(/i.test(v)) return "may only use url(#id) of an element in this same SVG";
  return `colour "${v.slice(0, 20)}" is not allowed: use a hex colour like #5eead4, none, currentColor or one of ${SVG_COLOR_TOKENS.join("|")}`;
}

export type Anim = { type: "draw" | "pop" | "fade" | "pulse" | "move"; dx: number; dy: number; delay: number };
const ANIM_RE = new RegExp(`^(?:(draw|pop|fade|pulse)|move:(${NUM}),(${NUM}))$`);
/** Reads data-anim / data-delay of an already-validated node; null when it has no animation. */
export function parseAnim(attrs: Record<string, string>): Anim | null {
  const m = ANIM_RE.exec(attrs["data-anim"] ?? "");
  if (!m) return null;
  const delay = /^\d{1,3}$/.test(attrs["data-delay"] ?? "") ? Number(attrs["data-delay"]) : 0;
  return m[1] ? { type: m[1] as Anim["type"], dx: 0, dy: 0, delay } : { type: "move", dx: Number(m[2]), dy: Number(m[3]), delay };
}

function checkAttr(tag: string, name: string, v: string, isRoot: boolean, refs: string[]): string | null {
  if (GEOM.has(name)) return NUM_RE.test(v) && inRange(Number(v)) ? null : `must be a plain number in ${SVG_LIMITS.min}..${SVG_LIMITS.max}`;
  if (SIZE.has(name)) return NUM_RE.test(v) && Number(v) >= 0 && inRange(Number(v)) ? null : `must be a plain number in 0..${SVG_LIMITS.max}`;
  if (UNIT.has(name)) return NUM_RE.test(v) && Number(v) >= 0 && Number(v) <= 1 ? null : "must be a number from 0 to 1";
  if (SIMPLE_ENUM[name]) return SIMPLE_ENUM[name]!.includes(v) ? null : `must be one of ${SIMPLE_ENUM[name]!.join("|")}`;
  switch (name) {
    case "stroke-width":
      return NUM_RE.test(v) && Number(v) >= 0 && Number(v) <= 100 ? null : "must be a number from 0 to 100";
    case "font-size":
      return NUM_RE.test(v) && Number(v) >= 1 && Number(v) <= 400 ? null : "must be a number from 1 to 400";
    case "font-weight":
      return /^(normal|bold|[1-9]00)$/.test(v) ? null : "must be normal, bold or 100..900";
    case "font-family":
      return (SVG_FONTS as readonly string[]).includes(v) ? null : `must be one of ${SVG_FONTS.join("|")}`;
    case "stroke-dasharray":
      return /^\d+(?:\.\d+)?(?:[ ,]+\d+(?:\.\d+)?){0,3}$/.test(v) ? null : "must be 1-4 plain numbers";
    case "d":
      return pathData(v);
    case "points":
      return numList(v, SVG_LIMITS.points);
    case "transform":
      return transform(v);
    case "fill":
    case "stroke":
      return color(v, true, refs);
    case "stop-color":
      return color(v, false, refs);
    case "marker-start":
    case "marker-mid":
    case "marker-end": {
      const u = URL_REF.exec(v);
      if (u) refs.push(u[1]!);
      return u ? null : "must be url(#id) of a marker in this SVG";
    }
    case "orient":
      return v === "auto" || (NUM_RE.test(v) && inRange(Number(v))) ? null : "must be auto or a number";
    case "id":
      return ID.test(v) ? null : "must be a letter then letters, digits, _ or - (max 32)";
    case "viewBox":
      if (isRoot) return v.trim().split(/[\s,]+/).join(" ") === `0 0 ${SVG_VIEW} ${SVG_VIEW}` ? null : `must be exactly "0 0 ${SVG_VIEW} ${SVG_VIEW}"`;
      return tag === "marker" && numList(v, 60) === null && v.trim().split(/[\s,]+/).length === 4 ? null : "must be 4 plain numbers";
    case "xmlns":
      return isRoot && v === "http://www.w3.org/2000/svg" ? null : 'is only allowed on <svg> as "http://www.w3.org/2000/svg"';
    case "data-anim": {
      const m = ANIM_RE.exec(v);
      if (!m) return "must be draw, pop, fade, pulse or move:<x>,<y>";
      if (m[2] !== undefined && !(Math.abs(Number(m[2])) <= 1000 && Math.abs(Number(m[3])) <= 1000)) return "move offsets must be within -1000..1000";
      if (!ANIM_TAGS.has(tag)) return `cannot animate <${tag}>: use it on a shape, <g> or <text>`;
      if (v === "draw" && !SHAPES.has(tag)) return "draw only works on path, line, polyline, polygon, rect, circle and ellipse";
      return null;
    }
    case "data-delay":
      return /^\d{1,3}$/.test(v) && Number(v) <= 300 ? null : "must be a whole number of frames, 0..300";
    default:
      return undefined as unknown as string; // unknown attribute: handled by the caller
  }
}

class Fatal extends Error {}

/** Parses and validates. Never throws; returns the allow-listed tree or the problems (for retry feedback). */
export function sanitizeSvg(src: unknown): SvgResult {
  if (typeof src !== "string") return { ok: false, problems: ["svg must be a string"] };
  if (src.length > SVG_LIMITS.chars) return { ok: false, problems: [`svg is ${src.length} characters, over the ${SVG_LIMITS.chars} cap`] };
  const soft: string[] = [];
  const refs: string[] = [];
  const ids = new Set<string>();
  try {
    const root = parse(src, soft, refs, ids);
    for (const r of refs) if (!ids.has(r)) soft.push(`url(#${r}) points at an id that does not exist in this SVG`);
    const texts = countTag(root, "text");
    if (texts > SVG_LIMITS.texts) soft.push(`${texts} <text> elements, over the ${SVG_LIMITS.texts} cap`);
    if (soft.length === 0) return { ok: true, root };
  } catch (e) {
    if (!(e instanceof Fatal)) throw e;
    soft.unshift(e.message);
  }
  return { ok: false, problems: soft.slice(0, 10) };
}

function countTag(n: SvgNode, tag: string): number {
  return (n.tag === tag ? 1 : 0) + n.kids.reduce<number>((a, k) => a + (typeof k === "string" ? 0 : countTag(k, tag)), 0);
}

function parse(s: string, soft: string[], refs: string[], ids: Set<string>): SvgNode {
  const fatal = (m: string): never => {
    throw new Fatal(m);
  };
  if (s.includes("&")) fatal("& is not allowed (no entities): write the plain character instead");
  if (s.includes("\0")) fatal("NUL characters are not allowed");
  const stack: SvgNode[] = [];
  let root: SvgNode | undefined;
  let done = false;
  let count = 0;
  let i = 0;
  const n = s.length;
  const OPEN = /<([A-Za-z][A-Za-z0-9:_-]*)/y;
  const CLOSE = /<\/([A-Za-z][A-Za-z0-9:_-]*)\s*>/y;
  const ATTR = /([A-Za-z_:][A-Za-z0-9_:.-]*)\s*=\s*(?:"([^"<]*)"|'([^'<]*)')/y;
  while (i < n) {
    if (s[i] !== "<") {
      const j = s.indexOf("<", i);
      const raw = s.slice(i, j < 0 ? n : j);
      i = j < 0 ? n : j;
      if (raw.trim() === "") continue;
      const top = stack[stack.length - 1];
      if (!top) fatal("text outside the <svg> element");
      else if (!TEXT_TAGS.has(top.tag)) fatal(`text is only allowed inside <text>, <tspan> or <title>, not <${top.tag}>`);
      else if (BAD_TEXT.test(raw)) fatal("text has control or direction-override characters");
      else top!.kids.push(raw.replace(/\s+/g, " ").trim());
      continue;
    }
    const c = s[i + 1];
    if (c === "!") fatal("comments, CDATA and DOCTYPE are not allowed");
    if (c === "?") fatal("XML declarations and processing instructions are not allowed");
    if (c === "/") {
      CLOSE.lastIndex = i;
      const m = CLOSE.exec(s);
      if (!m) fatal("malformed closing tag");
      const top = stack.pop();
      if (!top || top.tag !== m![1]) fatal(`closing tag </${m![1]}> does not match the open <${top?.tag ?? "nothing"}>`);
      i = CLOSE.lastIndex;
      if (stack.length === 0) done = true;
      continue;
    }
    if (done) fatal("content after the closing </svg>");
    OPEN.lastIndex = i;
    const m = OPEN.exec(s);
    if (!m) fatal("malformed tag");
    const tag = m![1]!;
    if (!TAGS.has(tag)) fatal(`<${tag}> is not allowed (tags are case sensitive). Allowed: ${SVG_TAGS.join(", ")}`);
    if (!root && tag !== "svg") fatal("the first element must be <svg>");
    if (root && tag === "svg") fatal("nested <svg> is not allowed");
    if (++count > SVG_LIMITS.elements) fatal(`more than ${SVG_LIMITS.elements} elements`);
    if (stack.length + 1 > SVG_LIMITS.depth) fatal(`nesting deeper than ${SVG_LIMITS.depth} levels`);
    i = OPEN.lastIndex;
    const node: SvgNode = { tag, attrs: {}, kids: [] };
    let selfClose = false;
    for (;;) {
      const ws = /^\s*/.exec(s.slice(i))![0].length;
      const hadWs = ws > 0;
      i += ws;
      if (i >= n) fatal(`<${tag}> is not closed`);
      if (s[i] === ">") {
        i++;
        break;
      }
      if (s[i] === "/" && s[i + 1] === ">") {
        selfClose = true;
        i += 2;
        break;
      }
      if (!hadWs) fatal(`<${tag}> has a malformed attribute list (missing space or bad character)`);
      ATTR.lastIndex = i;
      const a = ATTR.exec(s);
      if (!a) fatal(`<${tag}> has a malformed attribute near "${s.slice(i, i + 20)}" (use name="value" with plain quotes)`);
      i = ATTR.lastIndex;
      const name = a![1]!;
      const value = (a![2] ?? a![3] ?? "").trim();
      if (Object.hasOwn(node.attrs, name)) soft.push(`<${tag}> repeats attribute ${name}`);
      else {
        const prob = checkAttr(tag, name, value, tag === "svg" && !root, refs);
        if (prob === (undefined as unknown as string)) {
          const hint = FORBIDDEN_HINT.find(([re]) => re.test(name))?.[1];
          soft.push(`<${tag}> attribute "${name.slice(0, 30)}" is not allowed${hint ? `: ${hint}` : ""}`);
        } else if (prob) soft.push(`<${tag}> ${name}="${value.slice(0, 30)}" ${prob}`);
        else {
          node.attrs[name] = value;
          if (name === "id") {
            if (ids.has(value)) soft.push(`duplicate id "${value}"`);
            ids.add(value);
          }
        }
      }
    }
    if (tag === "svg" && !root && node.attrs.viewBox === undefined) soft.push(`<svg> needs viewBox="0 0 ${SVG_VIEW} ${SVG_VIEW}"`);
    if (node.attrs.d === undefined && tag === "path") soft.push("<path> needs d");
    if (stack.length) stack[stack.length - 1]!.kids.push(node);
    else root = node;
    if (selfClose) {
      if (stack.length === 0) done = true;
    } else stack.push(node);
  }
  if (stack.length) fatal(`<${stack[stack.length - 1]!.tag}> is not closed`);
  if (!root) fatal("empty svg");
  checkText(root!, soft);
  return root!;
}

function textOf(n: SvgNode): string {
  return n.kids.map((k) => (typeof k === "string" ? k : textOf(k))).join(" ");
}
function checkText(n: SvgNode, soft: string[]): void {
  if (n.tag === "text" || n.tag === "title") {
    const t = textOf(n);
    if ([...t].length > SVG_LIMITS.text) soft.push(`text "${t.slice(0, 20)}..." is ${[...t].length} characters, over the ${SVG_LIMITS.text} cap`);
  }
  for (const k of n.kids) if (typeof k !== "string") checkText(k, soft);
}

/** All visible label strings (for the banned-wording rule). */
export function svgLabels(root: SvgNode): string[] {
  const out: string[] = [];
  const walk = (n: SvgNode) => {
    if (n.tag === "text" || n.tag === "title") out.push(textOf(n));
    else n.kids.forEach((k) => typeof k !== "string" && walk(k));
  };
  walk(root);
  return out;
}

// ---- layout rules (on a sanitized tree) ----
type Box = [number, number, number, number];
const lum = (hex: string): number => {
  const h = hex.slice(1);
  const f = h.length <= 4 ? [...h.slice(0, 3)].map((c) => c + c) : [h.slice(0, 2), h.slice(2, 4), h.slice(4, 6)];
  const [r, g, b] = f.map((x) => {
    const v = parseInt(x, 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
};
const MIN_LUM = 0.2; // the video background is dark: hex strokes and label colours must be at least this bright

const nums = (v: string | undefined): number[] => (v?.match(new RegExp(NUM, "g")) ?? []).map(Number);

/** Only translate() transforms are followed; anything else makes the box unknown (null). */
function translateOf(t: string | undefined): [number, number] | null {
  if (!t) return [0, 0];
  let x = 0;
  let y = 0;
  const re = /(\w+)\(([^)]*)\)/g;
  for (let m = re.exec(t); m; m = re.exec(t)) {
    if (m[1] !== "translate") return null;
    const a = nums(m[2]);
    x += a[0] ?? 0;
    y += a[1] ?? 0;
  }
  return [x, y];
}

function pathBox(d: string): Box | null {
  const ARGS: Record<string, number> = { m: 2, l: 2, h: 1, v: 1, c: 6, s: 4, q: 4, t: 2, a: 7, z: 0 };
  const toks = d.match(new RegExp(`[A-Za-z]|${NUM}`, "g")) ?? [];
  let cx = 0;
  let cy = 0;
  let sx = 0;
  let sy = 0;
  let cmd = "";
  const pts: [number, number][] = [];
  for (let i = 0; i < toks.length; ) {
    if (/[A-Za-z]/.test(toks[i]!)) cmd = toks[i++]!;
    const lo = cmd.toLowerCase();
    const rel = cmd === lo;
    const k = ARGS[lo];
    if (k === undefined) return null;
    if (k === 0) {
      cx = sx;
      cy = sy;
      continue;
    }
    const a = toks.slice(i, i + k).map(Number);
    if (a.length < k || a.some((v) => Number.isNaN(v))) return null;
    i += k;
    const ex = lo === "v" ? cx : a[k - 2]!;
    const ey = lo === "h" ? cy : lo === "v" ? a[0]! : a[k - 1]!;
    if (lo === "h") cx = rel ? cx + a[0]! : a[0]!;
    else if (lo === "v") cy = rel ? cy + a[0]! : a[0]!;
    else {
      cx = rel ? cx + ex : ex;
      cy = rel ? cy + ey : ey;
    }
    if (lo === "m") {
      sx = cx;
      sy = cy;
      if (cmd === "m") cmd = "l";
      else if (cmd === "M") cmd = "L";
    }
    pts.push([cx, cy]);
  }
  return boxOf(pts);
}
const boxOf = (pts: [number, number][]): Box | null =>
  pts.length ? [Math.min(...pts.map((p) => p[0])), Math.min(...pts.map((p) => p[1])), Math.max(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[1]))] : null;

type Ctx = { tx: number; ty: number; known: boolean; fontSize?: number; anchor: string; fill?: string };
const N = (a: Record<string, string>, k: string): number => Number(a[k] ?? 0);

function nodeBox(n: SvgNode, c: Ctx): Box | null {
  const a = n.attrs;
  switch (n.tag) {
    case "rect":
      return [N(a, "x"), N(a, "y"), N(a, "x") + N(a, "width"), N(a, "y") + N(a, "height")];
    case "circle":
      return [N(a, "cx") - N(a, "r"), N(a, "cy") - N(a, "r"), N(a, "cx") + N(a, "r"), N(a, "cy") + N(a, "r")];
    case "ellipse":
      return [N(a, "cx") - N(a, "rx"), N(a, "cy") - N(a, "ry"), N(a, "cx") + N(a, "rx"), N(a, "cy") + N(a, "ry")];
    case "line":
      return boxOf([[N(a, "x1"), N(a, "y1")], [N(a, "x2"), N(a, "y2")]]);
    case "polyline":
    case "polygon": {
      const v = nums(a.points);
      return boxOf(Array.from({ length: v.length >> 1 }, (_, i) => [v[2 * i]!, v[2 * i + 1]!] as [number, number]));
    }
    case "path":
      return pathBox(a.d ?? "");
    case "text": {
      const fs = Number(a["font-size"] ?? c.fontSize ?? 0);
      const w = [...textOf(n)].length * fs * 0.58;
      const x = N(a, "x");
      const anchor = a["text-anchor"] ?? c.anchor;
      const x0 = anchor === "middle" ? x - w / 2 : anchor === "end" ? x - w : x;
      return [x0, N(a, "y") - fs * 0.8, x0 + w, N(a, "y") + fs * 0.2];
    }
    default:
      return null;
  }
}

const label = (n: SvgNode): string => {
  const first = n.tag === "text" ? `"${textOf(n).slice(0, 20)}"` : Object.entries(n.attrs).filter(([k]) => !k.startsWith("data-")).slice(0, 2).map(([k, v]) => `${k}=${v.slice(0, 12)}`).join(" ");
  return `<${n.tag}${first ? ` ${first}` : ""}>`;
};
const hit = (a: Box, b: Box) => Math.min(a[2], b[2]) - Math.max(a[0], b[0]) > 2 && Math.min(a[3], b[3]) - Math.max(a[1], b[1]) > 2;

/** Deterministic house rules for a sanitized diagram. Plain sentences, ready for retry feedback. */
export function svgLayoutProblems(root: SvgNode): string[] {
  const out: string[] = [];
  const S = SVG_SAFE;
  let animated = 0;
  let statics = 0;
  const textBoxes: { n: SvgNode; b: Box }[] = [];
  const walk = (n: SvgNode, c: Ctx, top: boolean) => {
    const t = translateOf(n.attrs.transform);
    const here: Ctx = {
      tx: c.tx + (t?.[0] ?? 0),
      ty: c.ty + (t?.[1] ?? 0),
      known: c.known && t !== null,
      fontSize: n.attrs["font-size"] ? Number(n.attrs["font-size"]) : c.fontSize,
      anchor: n.attrs["text-anchor"] ?? c.anchor,
      fill: n.attrs.fill ?? c.fill,
    };
    const anim = parseAnim(n.attrs);
    if (!top && (SHAPES.has(n.tag) || n.tag === "text")) {
      if (anim) animated++;
      else statics++;
    } else if (anim) animated++;
    if (n.attrs.stroke && HEX.test(n.attrs.stroke) && lum(n.attrs.stroke) < MIN_LUM) out.push(`${label(n)} stroke ${n.attrs.stroke} is too dark for the dark background (use a brighter colour)`);
    if (n.tag === "text") {
      if (!here.fontSize || here.fontSize < SVG_LIMITS.minFont) out.push(`${label(n)} font-size is ${here.fontSize ?? "missing"}: text needs font-size of at least ${SVG_LIMITS.minFont}`);
      if (!here.fill || here.fill === "none") out.push(`${label(n)} has no visible fill: set a bright fill on the text`);
      else if (HEX.test(here.fill) && lum(here.fill) < MIN_LUM) out.push(`${label(n)} fill ${here.fill} is too dark for the dark background (use a brighter colour)`);
    }
    if (here.known && (SHAPES.has(n.tag) || n.tag === "text")) {
      const b = nodeBox(n, here);
      if (b) {
        const p: Box = [b[0] + here.tx, b[1] + here.ty, b[2] + here.tx, b[3] + here.ty];
        const spots: Box[] = anim?.type === "move" ? [p, [p[0] + anim.dx, p[1] + anim.dy, p[2] + anim.dx, p[3] + anim.dy]] : [p];
        if (spots.some((q) => q[0] < S.x0 || q[1] < S.y0 || q[2] > S.x1 || q[3] > S.y1))
          out.push(`${label(n)} is outside the safe area (x ${S.x0}..${S.x1}, y ${S.y0}..${S.y1}; the bottom is kept free for captions)`);
        if (n.tag === "text" && anim?.type !== "move") textBoxes.push({ n, b: p });
      }
    }
    for (const k of n.kids) if (typeof k !== "string") walk(k, here, false);
  };
  walk(root, { tx: 0, ty: 0, known: true, anchor: "start" }, true);
  if (animated < 3) out.push(`only ${animated} element(s) have data-anim: at least 3 must move (draw, pop, fade, pulse or move)`);
  if (statics < 1) out.push("nothing is visible at the start: leave at least one element without data-anim");
  if (countTag(root, "text") < 2) out.push("add at least 2 text labels");
  for (let i = 0; i < textBoxes.length; i++)
    for (let j = i + 1; j < textBoxes.length; j++)
      if (hit(textBoxes[i]!.b, textBoxes[j]!.b)) out.push(`labels ${label(textBoxes[i]!.n)} and ${label(textBoxes[j]!.n)} overlap: move one`);
  return out;
}

// ---- animation maths (frame driven; the caller passes the frame, never a clock) ----
export const FADE_FRAMES = 12;
export const MOVE_FRAMES = 30;
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** Frames to draw one stroke on, linear, 21 (short) to 36 (long). `diag` is its box diagonal in viewBox units. */
export const drawFrames = (diag = 450): number => Math.round(21 + 15 * clamp01(diag / 900));

export type AnimState = { opacity: number; scale: number; dx: number; dy: number; draw: number | null };
/** State of an animated element at `frame`. `spring` is the 0..1+ pop spring for (frame - delay); `dur` the draw length in frames. */
export function animAt(a: Anim | null, frame: number, spring = 1, dur = 28): AnimState {
  const rest: AnimState = { opacity: 1, scale: 1, dx: 0, dy: 0, draw: null };
  if (!a) return rest;
  const t = frame - a.delay;
  switch (a.type) {
    case "pulse":
      return t < 0 ? rest : { ...rest, scale: 1 + 0.08 * Math.sin((2 * Math.PI * t) / 30) };
    case "fade":
      return { ...rest, opacity: clamp01(t / FADE_FRAMES) };
    case "pop":
      return t < 0 ? { ...rest, opacity: 0, scale: 0 } : { ...rest, scale: spring };
    case "move": {
      if (t < 0) return { ...rest, opacity: 0 };
      const p = clamp01(t / MOVE_FRAMES);
      const e = p * p * (3 - 2 * p);
      return { ...rest, dx: a.dx * e, dy: a.dy * e };
    }
    case "draw": {
      const p = clamp01(t / dur);
      return { ...rest, opacity: p > 0 ? 1 : 0, draw: p };
    }
  }
}

/** Index of the step caption showing at `fraction` of the scene (-1 before the first). Steps are used in order of `at`. */
export function stepAt(steps: readonly { at: number }[], fraction: number): number {
  let k = -1;
  [...steps.keys()].sort((a, b) => steps[a]!.at - steps[b]!.at).forEach((i) => {
    if (steps[i]!.at <= fraction) k = i;
  });
  return k;
}

/** Box diagonal of a shape, for drawFrames. */
export function diagOf(n: SvgNode): number {
  const b = nodeBox(n, { tx: 0, ty: 0, known: true, anchor: "start" });
  return b ? Math.hypot(b[2] - b[0], b[3] - b[1]) : 450;
}

/** Tiny hand-written example (client -> load balancer -> servers, with hopping packets). Used in the fill prompt, the sample and tests. */
export const SVG_EXAMPLE = `<svg viewBox="0 0 1000 1000">
<g fill="none" stroke="#5eead4" stroke-width="6" stroke-linecap="round">
<rect x="60" y="220" width="160" height="110" rx="16" data-anim="pop"/>
<rect x="420" y="220" width="160" height="110" rx="16" data-anim="pop" data-delay="8"/>
<rect x="780" y="90" width="160" height="90" rx="14" data-anim="pop" data-delay="16"/>
<rect x="780" y="270" width="160" height="90" rx="14" data-anim="pop" data-delay="20"/>
<rect x="780" y="450" width="160" height="90" rx="14" data-anim="pop" data-delay="24"/>
<path d="M220 275 H420" data-anim="draw" data-delay="30"/>
<path d="M580 275 L780 135 M580 275 H780 M580 275 L780 495" data-anim="draw" data-delay="40"/>
</g>
<circle cx="220" cy="275" r="18" fill="#fbbf24" data-anim="move:200,0" data-delay="70"/>
<circle cx="580" cy="275" r="18" fill="#fbbf24" data-anim="move:200,0" data-delay="105"/>
<rect x="780" y="270" width="160" height="90" rx="14" fill="none" stroke="#fbbf24" stroke-width="6" data-anim="pulse" data-delay="140"/>
<g font-size="44" font-weight="700" fill="#f2f4f8" text-anchor="middle">
<text x="140" y="400">Client</text>
<text x="500" y="400">Balancer</text>
<text x="860" y="600">Servers</text>
</g>
</svg>`;
