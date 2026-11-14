---
name: draw-objects
description: Draw any object a video needs (a laptop, a server, a shipping container, a whale, a cell, a bridge...) in code, as flat 2D vector art in the video's style, and animate it. Use for every Explainer scene that shows something, in scene/video.tsx.
---

# Draw any object (2D, in code)

An Explainer shows the things it talks about. You can draw **any object** the script needs: nothing is limited to a
library. Draw it from shapes, in the video's style, and make it move with the narration.

Read `vidtsx-2d-generator` first: its crash and flicker rules (frame-based motion only, clamped `interpolate`, seeded
randomness) apply to every drawing here.

## 1. Look and colours

- Style: flat 2D vector art (clean shapes, 2-4 tones per object, a soft shadow or highlight at most). No 3D, no photos.
- Colours and fonts come from the video's style: `ref/openmontage/themes/<style>.json` (`primaryColor`, `accentColor`,
  `backgroundColor`, `surfaceColor`, `textColor`, `mutedTextColor`, `chartColors`, `headingFont`, `bodyFont`). Copy the hex
  values into constants at the top of the file. No other colours except tints of these.
- One idea per scene, big and centred, readable on a phone: the main object fills about half the frame's width.

## 2. Build an object

Make every object a small component with props (position, size, colour, state). Compose it from simple parts:

```tsx
const Server = ({ x, y, s = 1, lit = 0 }: { x: number; y: number; s?: number; lit?: number }) => (
  <svg x={x} y={y} width={220 * s} height={300 * s} viewBox="0 0 220 300" overflow="visible">
    <rect x={10} y={10} width={200} height={280} rx={18} fill={SURFACE} stroke={PRIMARY} strokeWidth={6} />
    {[0, 1, 2].map((i) => (
      <g key={i} transform={`translate(30, ${40 + i * 80})`}>
        <rect width={160} height={56} rx={10} fill={BG} />
        <circle cx={136} cy={28} r={9} fill={ACCENT} opacity={0.3 + 0.7 * lit} />
      </g>
    ))}
  </svg>
);
```

- Shapes: `<svg>`, `<g>`, `<rect>`, `<circle>`, `<ellipse>`, `<path>`, `<polygon>`, `<line>`, `<linearGradient>`; HTML
  `<div>` boxes are fine for simple cards.
- Curves: write `<path d="...">` with `M`, `L`, `Q`, `C`, `A` commands. Sketch the outline in a 100 x 100 or 200 x 200 box,
  then scale it.
- Recognisable first: give each object the one or two features people know it by (a laptop's hinge and keyboard, a whale's
  tail and spout, a container's corrugated ribs). Label it in plain text when it could be mistaken.
- Reuse what exists when it fits: `yt-old/<lib>` (the old app's drawings, see `ref/lib/index.md`) and `yt-om/<Component>`
  (OpenMontage's components, see `ref/openmontage/COMPONENTS.md`). Draw your own for everything else.

## 3. Make it move with the words

- Each beat's start and end times are in `input/script.json`; word times are in `input/words.json`. A thing appears when
  its word is spoken (frame = seconds x 30).
- Motions: pop in (`spring` scale 0 to 1), slide in, assemble (parts fly together), fill or light up (opacity, colour),
  morph between two states (interpolate positions), follow a path (`@remotion/paths`), shake for a problem, a check mark for a
  fix. Keep every object alive with a small idle motion (float, blink, pulse).
- Show cause and effect: arrows that draw on, objects that move from one place to another, before vs after side by side.

## 4. Rules

- No remote images and no `data:` URLs: every picture is drawn or comes from `assets/` with `staticFile()`.
- No emoji (the render box has no emoji font; they draw as boxes): draw icons as shapes.
- No text as a picture: text is for labels and short captions only.

## 5. Look at it

Run `check_code`, then `preview_frames` with about one frame per beat (mid-beat). Look at every frame: is each object
recognisable at phone size, on-style, inside the safe area, not overlapping text? Redraw anything that is not, and preview
again. Finish only when every beat's frame shows the thing its words talk about.
