---
name: vidtsx-2d-generator
description: The hard Remotion rules that keep a 2D animation file from crashing or flickering - frame-based motion only, strictly increasing interpolate ranges with clamping, Easing.bezier instead of wrapper easings, the real @remotion/paths functions, seeded randomness - plus safe zones, type sizes, the six style presets and the render-and-look rule. Use whenever writing or fixing scene/video.tsx. 2D only.
---

# 2D animation rules (Remotion)

The renderer calls the component once per frame at a fixed frame number. There is no event loop,
no memory between frames and no clock. Anything that assumes those breaks the render or makes it
flicker. Correctness beats cleverness: one bad `interpolate` range ends the render.

## Correctness rules

### Animation is frame-based, always
- Drive ALL motion from `useCurrentFrame()` + `interpolate()` (or `spring`).
- Never `useState`, `useEffect`, `setTimeout`, `setInterval`, CSS animations or transitions.
- Random: use `random("seed-" + i)` from `remotion` (deterministic). Never `Math.random`.
  Build random or procedural arrays at module level, never inside the component (flicker).
- Stagger entrances so elements arrive in sequence, not all at once.

### interpolate: input ranges strictly increasing, always clamped
```tsx
interpolate(frame, [0, 30, 60], [0, 1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }); // correct
interpolate(frame, [60, 30, 0], [0, 1, 0]); // throws: input range goes down
```
To reverse a mapping, flip the OUTPUT range, never the input. For index-based timing make sure
`start < end`. Pass both clamps unless you really want values past the keyframes.

### Easing: `Easing.bezier(...)` only
```tsx
const EASE_OUT = Easing.bezier(0.33, 1, 0.68, 1); // define once at module level
interpolate(frame, [0, 30], [0, 1], { easing: EASE_OUT, extrapolateRight: "clamp" });
// Easing.out(Easing.cubic) crashes: never the wrapper forms
```

### @remotion/paths: only the real functions
`evolvePath`, `getLength`, `getPointAtLength`, `getTangentAtLength`. Helpers like `makeCircle`,
`makeRect`, `makeLine` do not exist. Write SVG path strings by hand and animate with `evolvePath`.

## Layout
- Canvas 1080x1920 (portrait). Top 10%: platform UI. Bottom 22%: captions (the app draws them).
- Keep the main subject between 25% and 75% of the height, and big: at least 60% of the width
  at its key moment.
- Set `margin: 0` on text elements; browser defaults push layouts off-centre.

## Typography
| Element | Size | Weight |
|---|---|---|
| Headlines | 72-120 px | 700-900 |
| Subheadlines | 36-48 px | 500-700 |
| Body | 28-36 px | 400-500 |

Fonts come from `yt-old/fonts` (`FONT_DISPLAY`, `FONT_BODY`, `FONT_MONO`, `FONT_SERIF`,
`FONT_EDITORIAL`) or the `yt-kit` FONTS; they are installed in the renderer.

## Style presets
If the task names a style, read `references/style-presets.md` and use its palette. Otherwise
follow `ref/brand/brand.md`.

## Render it and look (do not skip)
A file is not done until you have LOOKED at it. Call `check_code`, then `preview_frames` with
the frames at each key moment (at most 8), and read every picture: text not clipped, nothing off
the safe area, each animated element visible when it should be, nothing overlapping. Fix what the
pictures show, preview the changed frames again, and only then call it done.
