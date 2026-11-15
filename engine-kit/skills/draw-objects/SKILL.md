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
- Fill the tall frame (1080 x 1920). One idea per scene, big and readable on a phone:
  - The main object is 60-85% of the frame's width (650-920 px) and sits in the middle band (y 450-1450). Small icons
    and labels go around it, never instead of it.
  - Use the whole height: a title or label above (y 200-420), the object in the middle, a second object, arrow or result
    below it. No more than about a third of any frame is empty background: `check_frames` measures the largest empty band of the
    picture (rows with no sharp edge between y 200 and 1650) and refuses a frame where it is over 40% of the height.
  - Text: titles 64-96 px, labels at least 40 px, never under 32 px. Keep 80 px from the left and right edges and leave the
    bottom 300 px for the app's captions.
  - Two things side by side (before and after, VM and container) each get about 420 px of width; stack them vertically
    instead when they need more room.

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

### Labels never touch the picture

A label under or beside an object must not overlap it. Typing a label's y by hand is how text ends up drawn on top of the
bottom of an icon (a past video printed TEST, SHIP and SCALE over their icons).

- Draw each object and its label as ONE component: `<Labeled label="TEST" size={...}>` where the label position is
  computed from the object's own size: `labelY = objectBottom + 28 + fontSize`, with `objectBottom = y + (height / 2) * s`
  for an icon drawn around its centre, or `y + height * s` for one drawn from its top-left. Write the object's height as a
  named constant next to its drawing; do not guess it.
- Label text is at least 40 px. A row of icons with labels is also an object row: each icon is at least 220 px wide and the
  row sits in the middle band, not in the last 400 px of the frame.
- Neighbouring labels need at least 40 px of space between them (compare their widths, about `0.6 x fontSize x letters`).

## 3. Make it move with the words

- Each beat's start and end times are in `input/script.json`; word times are in `input/words.json`. A thing appears when
  its word is spoken (frame = seconds x 30).
- Motions: pop in (`spring` scale 0 to 1), slide in, assemble (parts fly together), fill or light up (opacity, colour),
  morph between two states (interpolate positions), follow a path (`@remotion/paths`), shake for a problem, a check mark for a
  fix. Keep every object alive with a small idle motion (float, blink, pulse).
- **Pace: the viewer must be able to follow.** A past video ran passes 2, 3 and 4 of a sort in 75, 41 and 25 frames (under
  one second for the last) with the heading changing each time, and then cut hard to the next scene.
  - Anything the viewer has to read or understand (a heading, a number, a label, a new state) stays on screen at least 36
    frames (1.2 s) after it has finished appearing. A heading changes at most once every 60 frames.
  - When the narration repeats a step ("and again, and again"), show the step once or twice at full speed, then speed up
    visibly: a counter or a "x4" tag, a trail or ghost copies, and the motion eases (never a sudden jump). Never two
    different things change at once inside 30 frames.
  - Do not hard-cut between sections: overlap the outgoing and incoming sections by 10 to 15 frames (cross-fade or slide).
  - After writing the timings, list each section's length in frames next to the narration seconds it covers. Preview
    frames inside the fastest section too (3 frames across it); if any section is under 45 frames, lengthen it by taking
    time from a slower section, or merge it with its neighbour.
- Show cause and effect: arrows that draw on, objects that move from one place to another, before vs after side by side.

## 4. Rules

- No remote images and no `data:` URLs: every picture is drawn or comes from `assets/` with `staticFile()`.
- No emoji (the render box has no emoji font; they draw as boxes): draw icons as shapes.
- No text as a picture: text is for labels and short captions only.

## 5b. The shape of a Short: hook, twist, loop

A Short has a shape, not just a list of beats. Map the script's beats onto it:

1. **Hook (first ~3 s):** frame 0 already shows the payoff or the surprising object, fully drawn. No build-up from nothing.
2. **Setup:** the problem or starting situation, one object, one idea.
3. **Reveal (2-4 steps):** show how it works, one step per spoken idea, each landing on its word.
4. **Twist (near the end):** one turn that changes how the viewer sees it ("but it fails when...", "and the surprise is..."):
   change the picture here (colour shift, the object breaks or flips, a second object arrives), not only the words.
5. **Loop (last ~1 s):** the last frame matches frame 0, so the replay has no seam. Reverse the hook's entrance: settle the
   zoom or position back to frame 0's, bring the first beat's main object back to where it started, dissolve the twist away.
   `check_frames` allows a last frame equal to frame 0 (a loop); the middle frame must still differ so something moves.

**Loop fade, no ghost text:** the loop must not cross-fade two screens that both hold text. In the last ~1 s, fade the old
heading, labels and counters out completely (opacity 0) before the first beat's title and labels fade in, so no two texts
are ever visible on top of each other. Keep only the shared background and the main object during the cross-over. Check the
last 2 preview frames: if any letters overlap, fix the timing.

Never end on a call to action ("like", "subscribe", "follow"). End on the payoff, then loop. If the script has no twist, loop
anyway and give the final beat a small turn of its own; do not invent facts the script does not say.

## 5. The first frame

Frame 0 is the poster and the first thing the app checks: it must already show the first beat's main object at full
strength. Do not fade or pop it in from nothing; start it visible and animate from there (a small move, a glow, the next
part arriving). The final render refuses an empty or one-colour frame 0, a black or blank frame, and a video in which
frames 0, middle and last look the same.

## 5c. Show the idea, not a diagram of it

A viewer with the sound off should follow the story from the pictures alone. Plan this before drawing anything.

1. **Pick a picture people already know.** When the idea is abstract (software, networks, data, money, a process), do not draw
   the technical parts. Choose an everyday scene that works the same way (a post box, a queue at a counter, a pipe and a
   tap, a tunnel, a warehouse, a see-saw) and draw that. Write it in one line first: "this idea = <everyday scene>". Only
   the picture is new: the facts stay the script's, never add facts it does not say.
2. **One picture per idea.** Give each idea in the script its own picture, and never fewer than 4 different pictures in a Short
   of 25 s or more. A new picture means the layout changes, not only the state of the same objects. Ways to change it:
   - zoom in on one part (the part fills the frame and the rest leaves);
   - split the frame in two (before and after, here and there, cause and effect);
   - swap the main object (the phone leaves, the thing it talks to arrives);
   - change the camera (a top view, a close-up, the same object turned or moved to another third of the frame).
   The same device or box in the same place for more than about 12 s is a fixed set-up with moving parts: break it up at
   the next idea. Small changes inside it (a bar moving, a clock ticking, an item added) are motion, not a new picture.
   When two beats carry the same idea, keep the picture and show the change.
3. **Label the main things.** Each object that carries the story gets a label of at most 3 plain words, at least 48 px, and
   so does each important state change (for example "NO SIGNAL", "WAITING"). Use the narration's own word when the viewer
   will hear it; an everyday stand-in picture gets its plain name. Budget: at most 3 labels on screen at once, each inside
   the 80 px side margins and clear of its object (see "Labels never touch the picture"); shorten the text rather than the
   size.
4. **Real objects with a face.** An object shows the feature people know it by (section 2). Grey bars, plain boxes or empty
   cards that need explaining do not count.
5. **Fill the frame.** The main object is at least 60% of the frame's width, and what sits inside it is drawn large enough to
   read on a phone: no item inside a screen or box narrower than 220 px. Do not leave the inside of a device empty: put
   the things the narration talks about in it, large, or zoom in until they fill it. The other half of the picture holds
   the result, the second object or the label.
6. **Self-check before you finish:** look at the preview frames in a row, covering the words. Can you tell the story? Does
   each picture change from the one before it, unless two beats share one idea? The first and last frames match on purpose
   (the loop). If not, redraw the weak pictures.

## 5d. Landscape (1920 x 1080)

When the file's meta says width 1920, height 1080, the video is landscape and these numbers replace the tall-frame numbers in
sections 1, 2 and 5c. Everything else (hook, twist, loop, one picture per idea, labels, no ghost text) is the same.
A past landscape build drew small thin objects in the top two thirds and left the bottom third and both sides empty. Do not.

- **Use the whole frame, edge to edge.** Draw down to y 860. Only the bottom 220 px (y 860-1080) is kept free for captions; do
  not make the free band bigger than that, and never put a horizon, ground line or panel edge across the frame that turns
  the lower part into a dead strip. The background colour or scene runs the full width and height; objects and labels stay
  100 px from the left and right edges, and the bottom 220 px stays free of important drawing.
- **Big main object, from frame 0.** The main object is 55-75% of the width (1050-1440 px) and at least 450 px tall, in the
  middle band (y 160-860). Frame 0 shows it fully drawn and large (a sun, a device, a lake); clouds or small decoration alone
  do not count. Thin lines, dots and small icons are accents, never the main picture: draw rays, waves, arrows and beams at
  least 8 px thick, and show them as big shapes.
- **Use the width.** Two things side by side (before and after, cause and effect) each get about 800 px; a row of three or four
  items fits at 380-500 px each. Do not stack a column in the middle and leave both sides empty: if the left or right third
  of a frame has nothing but background, move or enlarge the objects.
- **Labels sit in clear space.** No beam, line, tag, ray or object may pass through a label's box. Work the box out (width about
  0.6 x font size x letters, height the font size) and keep 24 px clear of every shape that is on screen while the label shows.
  Put labels in the title band or in empty space beside the thing they name, never on top of a sun, a beam or another tag.
  A past landscape build printed "PRISM SPLITS LIGHT" under a red beam, "~10x" on top of "HOW MUCH SCATTERS" and "NEAR SUNSET"
  on the sun: move the label instead.
- **Both halves carry content.** Split the frame in thirds: the left third and the right third each hold part of the main
  object, an object, a bar or a label. A set-up that only fills one side (bars at the left, nothing at the right) is
  redrawn wider or re-centred.
- Title or label above (y 50-150), objects in the middle band, a result or second object beside it.
- Text: titles 72-110 px, labels at least 48 px (at least 40 px for tiny tags), never under 36 px. Keep 100 px from the left and
  right edges.
- Items inside a screen or box are at least 220 px wide, as in section 5c. Never lay out for the tall frame and just widen it.
- Preview frames and look at them as a 16:9 picture: is a third of the frame empty? Is the main object under half the width?
  Is frame 0 mostly background? Fix before you finish.

## 6. Look at it

Run `check_code`, then `preview_frames` with about one frame per beat (mid-beat). Look at every frame: is each object
recognisable at phone size, big enough (the sizes above), filling the frame, on-style, inside the safe area, not
overlapping text (check every label against the bottom of its object, with the numbers above)? Redraw anything that is not, and preview
again. Then run `check_frames` (the final render's own check) and fix the file until it passes. Finish only when the hook, twist and loop are drawn (section 5b), the story reads from the pictures alone (section 5c), every beat's
frame shows the thing its words talk about and `check_frames` passes.
