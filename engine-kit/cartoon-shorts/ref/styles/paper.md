# Paper and light style (`engine/styles/paper.js`, `window.Paper`)

![paper](paper.jpg)

## What it looks like and what it suits

Every scene is a diorama of cut paper. Flat colour layers with torn edges sit on top of each other,
each with a soft drop shadow, so the frame reads as real card stacked in depth. One motivated light
does the drama: a warm glow, a fan of light rays, dust drifting in the beam. Characters are dark
silhouettes with a thin rim of light on the side that faces the light. Words are cut out of cream
card in Fraunces 900. A paper grain tile over the whole frame finishes the look.

It suits cinematic and emotional stories: memories, tributes, history, sport legends, quiet turning
points, storybook fables. It does not suit fast comedy, busy explainers or bright daylight topics.
Night, dusk, interiors with one lamp and stadium tunnels work best.

Working example: `examples/paper/` (a lighthouse keeper's last night, 3 scenes, 5 lines, about 15.2 s).

## Modules and load order

```html
<script src="timeline.js"></script>
<script src="../../engine/styles/toon.js"></script>   <!-- needed by Paper.figure (the puppet rig) -->
<script src="../../engine/styles/paper.js"></script>
<script src="../../engine/core.js"></script>
<script src="scenes.js"></script>
<script>
document.getElementById('paper').style.backgroundImage = `url(${Paper.paperTile()})`;
Short.start(async () => buildEpisode(document.getElementById('world'), Short),
  {fonts: ['900 100px Fraunces', 'italic 900 100px Fraunces', '400 100px Anton']});
</script>
```

Add `<div id="paper"></div>` inside `#v`, after `#flash`, and style it:
`#paper{position:absolute;inset:0;pointer-events:none;mix-blend-mode:multiply;opacity:.35;background-size:512px 512px}`.
For captions copy the `<style>` block of `examples/paper/short.html` (Fraunces 900, no uppercase, no stroke, soft shadow).

## API cheat-sheet

All drawing helpers take an SVG element `g` first and append to it. Colours are CSS strings.

Shared defs (made once per svg, cached, safe to call every frame)
- `kit(el)` returns `{cut, cutS, sil, blur}`: ids of the big and small paper shadow filters (`url(#${kit(g).cut})`) plus caches.
- `silFilter(el, dark='#0b1020', rim='#ffd97a', dx=-4, dy=-3, glow=1.5)` returns `'url(#id)'`: fills a shape with `dark`
  and adds a `rim` of light. The rim shows on the side the offset points to: `dx=4` lights the right edge, `dy=-4` the top.
- `blurFilter(el, sd)` returns a cached `url(#id)` Gaussian blur.
- `grad(el, 'lin'|'rad', [[offset, colour, opacity?], ...], attrs={})` returns `'url(#id)'`. `lin` runs top to bottom.
  `attrs` go on the gradient element (for example `{cx, cy, r, gradientUnits: 'userSpaceOnUse'}`).

Paper shapes
- `torn(pts, amp=4, seed=1, step=18)` returns a path `d`: the polygon `[[x,y],...]` with a hand-cut, jittered edge.
  Same seed and same points give the same edge every frame.
- `ridge(x0, x1, yb, hFn, step=30)` returns points for a hill or wave line: top y is `hFn(x)`, closed down to `yb`.
- `layer(g, pts | d, fill, o)` returns the layer group. One paper layer: torn fill, a light cut edge, a shadow.
  `pts` is torn with `o.amp` (3.5), `o.seed` (1), `o.step` (16); a string `d` is used as is, untorn.
  `o.grad` stops for a vertical gradient (replaces `fill`), `o.small` small shadow, `o.shadow: false` none,
  `o.edge` edge colour or `false`, `o.ew` edge width (2.5).

Light (all use `mix-blend-mode: screen`)
- `glow(g, x, y, r, colour, op=.8)` a soft radial glow circle.
- `rays(g, x, y, ang, spread, len, n, colour, op=.35, t=0, seed=3)` a fan of `n` rays from (x, y). `ang` in degrees:
  0 right, 90 down, 180 left. Rays flicker with `t`. Returns the group.
- `dust(g, t, n, [x0, y0, w, h], colour='#fff6d6', seed=5, o)` motes drifting up inside the box.
  `o.up` (18 px/s), `o.drift` (6), `o.size` (3), `o.op` (.7).
- `confetti(g, t, n, seed=7, colours, o)` paper confetti falling over the full 1080 width; `o.speed` (1).

Characters
- `figure(g, pose, x, y, o)` returns `{grp, toon}`. A full-body `window.Toon` rig drawn through `silFilter`.
  `pose` is a Toon pose (`Toon.P.stand`, `Toon.cycle(ph, 1, 'walk')`, `Toon.mix(a, b, k)`). `o.s` scale (1),
  `o.dir` 1 faces right, -1 left, `o.filter` your own `silFilter(...)`, `o.look` extra Toon options merged over `DARK`
  (for example `{cap: '#000', beard: true, legs: 'pants'}`). The rig stands with its feet at (x, y);
  about 530 units tall at `s=1`. `toon.at('hand')` gives the hand position after drawing.
- `profile(g, x, y, s=1, o)` returns the group. A generic man in profile facing right: short swept-back hair, glasses,
  jacket. Origin near the ear; head top at y-178, shoulders end at y+330 (times `s`). `o.dir` -1 faces left,
  `o.filter` own silhouette filter (default rim on the right), `o.glint` colour of a glint on the lens.
- `PROFILE` the raw path strings (head, suit, lens, arm, collar). `DARK` the all-black Toon look used by `figure`.

Type
- `word(g, x, y, str, size, fill='#f7eedb', o)` returns the group. SVG text, `y` is the baseline, centred by default.
  `o.font` ('Fraunces'), `o.weight` (900), `o.italic`, `o.anchor` ('middle'), `o.ls` letter spacing, `o.shadow: false`.

Camera and grain
- `camera(layers, push, cx=540, cy=860, amount=.12, pan=[0,0])` parallax push. `layers` is `[[group, depth], ...]`:
  depth 1 moves most, bigger depths move less. `push` 0..1. Sets each group's `transform`.
- `paperTile()` returns a PNG data URL of a 512 px grain tile, for the `#paper` overlay.

Small helpers: `E(tag, attrs, parent)`, `f(n)` rounds to 0.1, `rng(seed)` returns a seeded random function, `clamp`.

## Minimal code (from the example)

```js
const P = window.Paper, { E, clamp } = P;
const sc = S.scene(world, 'lamp', 'cut'), a = S.sceneById.lamp.start, b = S.sceneById.lamp.end;
const L = ['sky', 'far', 'cliff', 'near'].map(() => E('g', {}, sc.cam));
E('rect', { x: -200, y: -200, width: 1480, height: 2320, fill: P.grad(L[0], 'lin', [[0, '#070b1c'], [1, '#2b3160']]) }, L[0]);
P.layer(L[1], P.ridge(-120, 560, 1060, x => 985 - 10 * Math.sin(x / 50), 24), '#1a2142', { amp: 2, seed: 31 });
// moving things: clear and redraw a group every frame while the scene is on
const fx = E('g', {}, L[2]);
S.ups.push(t => {
  if (t < a || t >= b) return;
  while (fx.firstChild) fx.firstChild.remove();
  P.glow(fx, 800, 620, 360, '#ffd97a', .9);
  P.rays(fx, 800, 620, 180 + 26 * Math.sin(t), 9, 1500, 6, '#ffe6a8', .4, t, 3);
  P.dust(fx, t, 34, [500, 400, 560, 440], '#fff6d6', 6, { op: .55 });
  P.figure(fx, Toon.P.stand, 852, 664, { s: .13, dir: -1, filter: P.silFilter(fx, '#0b1020', '#ffd97a', -2, -2, 1) });
  P.camera(L.map((g, i) => [g, [6, 4, 1.6, 1][i]]), S.eio(S.prog(t, a, b)), 800, 640, .12, [-30, 20]);
});
```

## Gotchas

- `toon.js` must load before `paper.js` is used: `figure()` calls `new window.Toon(...)`.
- The scene's root `<svg>` has no `ownerSVGElement`; paper.js handles that (`svgOf` falls back to the element itself).
  But a group that is not yet attached to an svg also has none, so its defs land inside the group itself.
  Attach a group to the scene before you pass it to any helper.
- `grad()` caches by stops and attributes. `rays()` makes a gradient keyed on its origin and length, so a light
  source that moves every frame adds a new gradient to `<defs>` every frame. Keep ray origins fixed, or round them.
- `Paper.camera` overwrites the `transform` of each layer group. Do not put your own transform on those groups,
  and do not also call `S.camera` on the same group. Layers inside `sc.cam` are fine.
- Text that must not drift (titles, cards) goes outside the camera layers, for example straight in `sc.svg`,
  or the push carries it out of the safe area (x 60..1000, y 200..1300).
- `figure()` builds a whole new Toon rig on every call. In a per-frame redraw that is fine for a few dozen small
  figures; for one big static figure, build it once and call `toon.set(pose, x, y, dir, s)` instead.
- Every `layer()` has a drop shadow filter. Hundreds of filtered layers slow the render: use `shadow: false`
  on thin stripes and fills you do not need to lift.
- `profile()` ends in a flat cut at y + 330 s. If it is big, draw a `'#0b1020'` rect under it to carry the body
  past the frame edge.
- `word()` text is not measured: at Fraunces 900, width is about 0.6 x size per capital. Check stills for overflow.
- Silhouettes on a dark sky need a rim: pick the rim offset toward the light source, and keep one light per scene.
