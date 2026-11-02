import { z } from "zod";
import { sanitizeSvg, SVG_COLOR_TOKENS, SVG_LIMITS } from "../../../../remotion/kit/svgDiagram";
import { base, copy, LIMITS } from "./common";

// The svg is DATA, checked by a strict allow-list sanitizer (it rejects anything else, never strips). Layout rules live in rules.ts.
export const schema = z
  .object({
    ...base,
    kind: z.literal("svg_diagram"),
    title: copy(LIMITS.title),
    svg: z.string().max(SVG_LIMITS.chars, `must be at most ${SVG_LIMITS.chars} characters`),
    // Caption changes: each shows from `at` (fraction of the scene, 0..1) until the next.
    steps: z
      .array(z.object({ at: z.number().min(0, "must be 0..1").max(1, "must be 0..1"), caption: copy(LIMITS.svgCaption).optional() }))
      .max(LIMITS.svgSteps, `must have at most ${LIMITS.svgSteps} steps`)
      .optional(),
  })
  .superRefine((s, ctx) => {
    const r = sanitizeSvg(s.svg);
    if (!r.ok) for (const p of r.problems) ctx.addIssue({ code: "custom", path: ["svg"], message: p });
  });

export const describe = `kind "svg_diagram": title (max ${LIMITS.title}); svg (string, max ${SVG_LIMITS.chars} chars) = an animated labelled diagram drawn as SVG with viewBox="0 0 1000 1000"; optional steps[] (max ${LIMITS.svgSteps}) {at 0..1 fraction of the scene, caption (max ${LIMITS.svgCaption})}. SVG rules: only these tags: svg g defs path rect circle ellipse line polyline polygon text tspan linearGradient radialGradient stop marker title (case sensitive, max ${SVG_LIMITS.elements} elements, nesting max ${SVG_LIMITS.depth}); attributes only x y cx cy r rx ry x1 y1 x2 y2 width height d points transform fill stroke stroke-width stroke-linecap stroke-linejoin stroke-dasharray opacity font-size font-weight font-family text-anchor id marker-start marker-end offset stop-color gradientUnits data-anim data-delay. NO script, style, class, href, image, use, foreignObject, animate, on* attributes, entities (&), comments. Colours: hex like #5eead4, none, currentColor (accent) or ${SVG_COLOR_TOKENS.join("|")}; strokes and text must be bright (dark background). Numbers plain, within -2000..3000. Text: at most ${SVG_LIMITS.texts} <text>, each max ${SVG_LIMITS.text} chars, font-size >= ${SVG_LIMITS.minFont}. Keep everything inside x 30..970, y 30..780 (the bottom is for captions), no background rectangle, labels must not overlap. Animate with data-anim="draw|pop|fade|pulse|move:<dx>,<dy>" (draw only on shapes/paths) and data-delay (frames, 0..300; 30 frames = 1 second): at least 3 animated elements and at least 1 static one; spread delays so the story unfolds.`;
