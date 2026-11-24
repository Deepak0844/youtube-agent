# Manga style

![manga example](manga.jpg)

Busts in a bold adventure-manga look. Thick ink outlines, small round pupils, chunky brows, strong noses and jaws.
Flat skin with one hard shadow, hatching in the darkest areas, huge toothy grins, a crying mouth and fountain tears.
SFX lettering ("DON!!", "HA HA HA!") in heavy tilted type with a double outline.

Suits: underdog stories, rivalries, vows and comebacks, reaction shots, sports, food battles, anything loud and emotional.
Less suited: calm explainers, data-heavy pieces, gentle or sad topics (try anime or painted).

Working example: `examples/manga/` (14 s, 5 lines, 3 scenes: vow, laugh, win).

## Modules and load order

```html
<script src="timeline.js"></script>
<script src="../../engine/styles/anime.js"></script>   <!-- first: manga.js reads window.Anime at load time -->
<script src="../../engine/styles/manga.js"></script>
<script src="../../engine/core.js"></script>
<script src="scenes.js"></script>
```

`sfx()` uses the Bangers font: keep `'400 100px Bangers'` in the `fonts` list of `Short.start`.
Exports: `window.Manga = { Bust, hatch, sfx, INK, DEF }`. Backgrounds and effects come from `Anime.FX`.

## Bust

`new Manga.Bust(parent, look)` makes a `<g>` in `parent` (kept as `bust.g`).
`bust.draw(x, y, scale, expression)` clears that group, redraws it and returns the bust.
Units are head units: head top -210, eye line 0, chin about 170, neck to 258, torso bottom at 772 (790 minus an 18 offset).
Torso is 680 wide (x -340..340). Spiky hair reaches -252. At scale `s` the bust is about `680*s` wide and its bottom edge is at `y + 772*s`.

### Look options (defaults from `Manga.DEF`)

| key | default | values |
|---|---|---|
| head | 'lean' | 'lean', 'square', 'round' |
| nose | 'small' | 'small', 'long', 'wide' |
| hairStyle | 'spiky' | 'spiky', 'swept', 'buzz' (any other name draws no hair) |
| skin, skinS | '#f8cfa4', '#e3a072' | skin and its hard shadow |
| blushC | '#f07d6a' | blush line colour |
| hair, hairS, hairH | '#3a2416', '#1e120b', '#8a6248' | base, spot black, shine (brows use hairS for 'swept', hair otherwise) |
| eyeW, eyeH, eyeGap, pupil | 54, 30, 52, 12 | eye size, half distance between eyes, pupil radius |
| mouthW | 1 | width factor of the grin, shout and cry mouths |
| age | 0 | 0..1 wrinkle lines |
| glasses, frame | false, '#2a2a30' | square glasses and their colour |
| stubble | 0 | 0..1 dotted stubble |
| outfit | 'kit' | 'kit' (shirt with V trim) or 'suit' |
| shirt, shirtS, trim | '#1f4fa8', '#143a85', '#f4b73b' | kit colours |
| badge | null | function (g, x, y, s) called at (150, 350, 1) on the kit chest |
| suit, suitS, tie, collar | '#1c2238', '#10142a', '#24345e', '#f6f3ea' | suit colours |

### Expression fields (second argument of draw)

| field | default | effect |
|---|---|---|
| eyes | 'open' | 'open', 'happy' (arcs), 'closed' (squeezed shut, for crying), 'wide' (small pupils), 'fierce' (narrow, shaded, adds -0.8 to brow) |
| look | [0, 0] | pupil direction, each -1..1 |
| lid | 0 | 0..1 lowers the upper lid |
| brow | 0 | positive lifts the inner ends (worried, crying), negative lowers them (angry) |
| mouth | 'smile' | 'smile', 'smirk', 'line', 'frown', 'grin', 'shout', 'cry' (any other name draws no mouth) |
| open | 0.7 | 0..1 for grin, shout and cry; also drops the jaw (grin up to 22 units, shout and cry up to 40) |
| tears | 0 | 0..1 tear streams down the cheeks |
| fountain | false | with tears above 0: two arcs of tears gushing sideways, about 240 units out and 320 down at tears 1 |
| blush | 0 | 0..1 hatched blush lines on the cheeks |
| sweat | false | sweat drop on the right temple plus stress lines |
| shade | 0 | 0..1 dark band across the eyes (the "menacing" look) |
| glare | false | white glare on glasses (needs look.glasses) |
| turn | 0 | -1..1 shifts eyes, brows, nose, mouth and face shadow sideways (ears and hair stay) |
| tilt | 0 | head and body rotation in degrees |

Signature faces from the example:

```js
{ mouth: 'grin', open: 1, eyes: 'fierce', brow: .1 }                                // the huge toothy grin
{ mouth: 'cry', open: .9, eyes: 'closed', tears: 1, fountain: true, brow: .9 }      // crying with joy
{ mouth: 'shout', open: 1, eyes: 'happy', glare: true }                             // laughing out loud
{ mouth: 'line', brow: .8, look: [-.6, -.4], sweat: true }                          // nervous
```

## Helpers

- `Manga.hatch(parent, d, x0, y0, x1, y1, gap = 9, ang = -35, w = 2.4, op = .8)`: parallel ink strokes clipped to path `d`, over the box x0,y0..x1,y1. Returns the group.
- `Manga.sfx(parent, x, y, text, size = 120, rot = -8, fill = '#ffd97a')`: SFX lettering centred on x, baseline at y, rotated `rot` degrees. Animate a pop by passing `size * ease`.
- `Manga.INK` is '#151214'. Use it for your own outlines so props match the busts.
- From `Anime.FX`: `speedLines(parent, cx, cy, r0, r1, n, color = '#fff', op = .5, seed = 1)`, `streaks(parent, x, y, w, h, n, ang, color, op, seed)`, `sparkle(parent, x, y, r, color = '#fff', op = 1)`, `bokeh(parent, x, y, r, color, op = .4)`, `tone(parent, color = '#000', size = 14, r = 2.4)` (returns a screentone `url(#..)` fill), `grain(parent, op)`, `blur(parent, sd)` (returns a filter url), `lin(el, stops, x1, y1, x2, y2)` and `rad(el, stops, cx, cy, r)` (gradient urls, stops as `[offset, color, opacity]`), `clip(el, d)` (clip-path url), `rng(seed)`, `curvy(points)`, `P(...)`.

## Minimal scene (from examples/manga/scenes.js)

```js
window.buildEpisode = (world, S) => {
  const { E, scene, T, clamp } = S, { FX } = Anime, M = Manga;
  const COOK = { head: 'lean', hairStyle: 'spiky', outfit: 'kit', shirt: '#f4f1e8', shirtS: '#c9c2b2', trim: '#e23b2e' };
  const back = x => { x = clamp(x); return 1 + 2.9 * Math.pow(x - 1, 3) + 1.9 * Math.pow(x - 1, 2); };
  const live = S.live;   // core helper: redraws a layer every frame and drops the <defs> the last frame added
  const sc = scene(world, 'vow', 'cut');
  live(sc, (g, t) => {
    E('rect', { width: 1080, height: 1920, fill: FX.rad(g, [[0, '#ffb347'], [1, '#a3171c']], .5, .43, .75) }, g);
    FX.speedLines(g, 540, 820, 300, 1500, 90, '#fff3d6', .6, 4);
    E('rect', { width: 1080, height: 1920, fill: FX.tone(g, '#5a0d10', 18, 3), opacity: .25 }, g);
    const b = new M.Bust(g, COOK).draw(540, 960, 1.25, { mouth: 'shout', open: 1, eyes: 'fierce', tilt: -3 });
    E('path', { d: 'M -128 -132 Q 0 -168 128 -132 L 126 -100 Q 0 -134 -126 -100 Z', fill: '#e23b2e', stroke: M.INK, 'stroke-width': 5 }, b.g);  // headband, in head units
    if (t > T('L1%45')) M.sfx(g, 540, 470, 'DON!!', 200 * back((t - T('L1%45')) / .25), -8, '#ffc93c');
  });
  S.shake('L1', .35, 22);
};
```

## Gotchas

- Load anime.js before manga.js. manga.js destructures `window.Anime` when it loads and throws without it.
- Every `draw()` adds new clip paths to the svg `<defs>` (head, eyes, mouth, hair, body). Calling it every frame without cleanup grows the page frame after frame. Use `S.live(sc, fn)` from the core, as above.
- Draw props in head units by appending to `bust.g` after `draw()` (headbands, hats, scars). They follow the bust's position, scale and tilt. Clear them with the next `draw()`.
- The torso ends with a flat edge at `y + 772*s`. If that is above 1920 the cut shows. Go bigger or lower, cover it with a counter or prop, or clip the busts inside a panel (`FX.clip`), as the laugh scene does.
- Mouth and hair names are not checked. Anime's `mouth: 'soft'` draws no mouth here, and an unknown `hairStyle` draws a bald head.
- `fountain: true` does nothing unless `tears` is above 0. At scale 1.3, centred at x 540, the arcs and drops span about x 70..1010, so leave room on both sides.
- A big open mouth drops the jaw up to 40 units. Props placed under the chin need that margin, or they cover the grin or the crying mouth.
- `S.impact(at)` inverts the frame for 3 frames. A `S.flashAt` at the same time washes it to grey: put the flash at `at+.1`.
- Keep faces and SFX above y 1300. Captions sit in y 1340..1560. Busts are wide: two side by side fit at scale 0.8 to 0.95.
- `sfx()` text is centred on x. Long words at size 100 or more need x near the middle to stay inside x 60..1000.
