import { COLOR_KEYS, DEFAULT_TSX_STYLE, tsxStyleOf, type StyleId } from "../../../remotion/kit/tsxlib/styledata";
import { PRESETS } from "../../../remotion/kit/presets";

// The per-style block of the code-scene prompt (tsx-prompt.ts) and the style line of the frame review. Pure: built from the style
// data (the owner's `sheet` colours, fonts, motion, pacing, captions, avoid list), so the prompt, the library and the picker agree.
// Everything here is ours (no user text): a style id is checked against the ten known ids first, anything else is AI Studio.

/** What this style does to the structure of a scene (the owner's rules per style). */
const RULES: Record<StyleId, string> = {
  clean_professional: "A clean white page with lots of empty space. Calm fades only, no bounce. At most three colours on screen. Never hold a scene under 2 s.",
  flat_motion: "Flat shapes, no gradients on shapes. Every element pops in on a bouncy spring (use MOTION.stiffness and MOTION.damping), growing from MOTION.scaleFrom. Fast, uneven cuts.",
  minimal_diagram: "Lines draw themselves: use evolvePath (from @remotion/paths) to draw each stroke on, one at a time. ONE accent colour (PALETTE.accent) only, no gradients, no bounce. Small labels, numbers in FONTS.mono.",
  premium_editorial: "One object per frame, one big idea per scene. Elements fade up by MOTION.rise px (12) over MOTION.frames frames. Generous margins, left-aligned text, no gradients.",
  storybook_calm: "Slow crossfades (a scene dissolves into the next over MOTION.frames frames). Warm light, soft serif type, the Backdrop's fireflies drift. Slow motion only, no hard bounce.",
  paper_cutout: "Flat paper shapes with hard offset shadows (no blur) and slightly tilted edges. A new set of shapes every 1.8-3 s. Scenes cut hard (no fades). Springs are snappy (MOTION.stiffness, MOTION.damping).",
  kinetic_type: "The words are the picture: huge type, no photos, no small text, at most 3 big words at once. Each word rises through a mask (an overflow-hidden box, text moving from 100% down to 0), staggered a few frames apart. Cut every 1.2-3 s.",
  retention_shorts: "The hook text is on screen at frame 0, full size (no build-up, no fade from black). Uneven cuts of 2-4 s, never two neighbouring scenes the same length. Punch-in: each new element starts at MOTION.scaleFrom (1.1) and springs to 1. Bold sticker text with a black outline.",
  wrapped_stats: "Numbers as a story that builds. A count-up number (Counter), ranked lists whose rows enter in order at the same speed, ONE highlighted number per scene (PALETTE.accent), the biggest number last, a still poster frame at the end.",
  ai_studio: "Airy glow backdrop and big drawn objects (the main drawing spans 60% of the width or more). Smooth fades over MOTION.frames frames, soft shadows only, never a text-only scene.",
};

const sec = (frames: number): string => (frames / 30).toFixed(1);

/** The text of the style block for one style id (unknown or missing = AI Studio). */
export function tsxStyleBlock(id: unknown): string {
  const s = tsxStyleOf(id);
  const p = PRESETS[s.id];
  const c = s.colors;
  const m = s.motion;
  const cap = s.captions;
  const colours = COLOR_KEYS.map((k) => `PALETTE.${k} ${c[k]}`).join(", ");
  const motion = m.spring
    ? `bouncy spring: spring({ frame, fps: 30, config: { stiffness: MOTION.stiffness, damping: MOTION.damping } }) with stiffness ${m.stiffness}, damping ${m.damping}`
    : `smooth, no overshoot (ease with EASE_OUT or Easing.bezier, or a spring with MOTION.stiffness ${m.stiffness} and MOTION.damping ${m.damping})`;
  return `STYLE: ${s.label} (${p.mood}) - the owner chose it; the page is ${s.light ? "LIGHT" : "dark"} and drawn by <Backdrop /> (${s.backdrop}). Stage, Headline, Label, Chip, Callout and Counter already use it.
- Colours: read them ONLY as PALETTE.name, never hex: ${colours}. Text is PALETTE.text on PALETTE.bg (checked for contrast); keep that pairing.
- Fonts: FONTS.display is ${p.fonts.heading} (weight ${s.headingWeight}), FONTS.body ${p.fonts.body}, FONTS.mono ${p.fonts.mono ?? "JetBrains Mono"}. Use only these.
- Motion: ${motion}; an element takes MOTION.frames = ${m.frames} frames to arrive and moves MOTION.rise = ${m.rise} px${m.scaleFrom !== 1 ? `, starting at scale MOTION.scaleFrom = ${m.scaleFrom}` : ""}.
- Pace: hold each scene PACE.min = ${s.pace.min} to PACE.max = ${s.pace.max} frames (${sec(s.pace.min)}-${sec(s.pace.max)} s), cuts ${p.pacing.cutRhythm === "uneven" ? "uneven (never two neighbours the same length)" : "even"}.
- Captions (the studio draws them, you do not): ${cap.layout}, ${cap.wordsPerPage} word(s) a page${cap.pillBg === "transparent" ? ", no pill" : ""}.
- Structure: ${RULES[s.id]}
- Never: ${p.antiPatterns.join("; ")}.`;
}

/** One line for the frame review: the style the video was made in (none chosen = AI Studio) and what it must not look like. */
export function styleReviewLine(id: unknown): string {
  const p = PRESETS[tsxStyleOf(id).id];
  return `The video was made in the style "${p.label}" (${p.mood}). Judge the frames against it. It must not look like: ${p.antiPatterns.join("; ")}.`;
}

export { DEFAULT_TSX_STYLE };
