# Anime style (`engine/styles/anime.js`, `window.Anime`)

![anime example](anime.jpg)

## What it looks like and what it suits

Soft, cel-shaded anime busts. Big eyes with a heavy lash mass, a gradient iris, two white highlights and an optional watery shine.
A narrow V jaw, a one-stroke nose, flat skin with one crescent shadow on the far cheek, blush hatching, tear streams and a sweat drop.
Effects in `Anime.FX`: focus speed lines, sparkles, soft bokeh, screentone dots, blur and grain.

Suits: emotional moments, before and after, waiting and relief, confessions, small personal wins, reaction close-ups.
Less suited: loud comedy and rivalry (try manga), data-heavy explainers (try kinetic text).

Working example: `examples/anime/` (13.1 s, 5 lines, 3 scenes: wait, open, joy). A student opens her acceptance letter:
worry and rain, an eye close-up while the letter slides out, then ACCEPTED with tears of joy.

## Modules and load order

```html
<script src="timeline.js"></script>
<script src="../../engine/styles/anime.js"></script>   <!-- before manga.js, which reads window.Anime at load -->
<script src="../../engine/core.js"></script>
<script src="scenes.js"></script>
```

Exports: `window.Anime = { Bust, FX, E, INK, DEFAULTS }`. `INK` is `'#2b1a14'` and every outline uses it.

## Bust

`new Anime.Bust(parent, look)` makes one `<g>` in `parent` (kept as `bust.g`). `bust.draw(x, y, scale, ex)` empties that group,
redraws it with `translate(x y) rotate(ex.tilt) scale(scale)` and returns the bust.
Head units: eye line 0, head top -204, chin about 158, hair top about -258 (swept) or -270 (spiky).
Neck reaches 252, torso spans y 200..758 and x -320..320 at the bottom. At scale `s` the bottom edge is at `y + 758*s`.
The eyes sit at `x = ±eyeGap` and the lash wing reaches about `eyeGap + eyeW/2 + 14`.

### Look options (`Anime.DEFAULTS`)

| key | default | notes |
|---|---|---|
| skin, skinS, blushC | '#f6d2b4', '#dda585', '#ec7a66' | skin, cel shadow, blush |
| hair, hairS, hairH | '#3a2a20', '#24180f', '#6b5444' | fill, shadow, highlight band |
| hairStyle | 'spiky' | 'spiky', 'swept', 'buzz'. Any other name draws no hair at all |
| iris, irisL | '#5a3d2b', '#c19470' | iris gradient dark to light |
| eyeW, eyeH, eyeGap | 74, 58, 56 | eye size and half distance between eyes |
| lash | .7 | 0..1, lash mass thickness and wing length |
| jaw | .3 | 0 = narrow soft chin, 1 = wide jaw |
| age | 0 | 0..1, crow's feet, smile lines, eye bags |
| glasses, frame | false, '#2b2b33' | square specs with a glint |
| outfit | 'kit' | 'kit' (V-neck shirt) or 'suit' (jacket, shirt, tie) |
| shirt, shirtS, trim, badge | '#1f4fa8', '#163b80', '#ffffff', null | kit colours; `badge(g, 140, 340, 1)` is called if set |
| suit, suitS, tie, collar | '#1c2238', '#121728', '#1d2a4d', '#f3f1ea' | suit colours |
| stubble | 0 | 0..1 shadow on the jaw |

### Expression fields (`ex`, every field optional)

| field | default | effect |
|---|---|---|
| eyes | 'open' | 'open', 'wide' (taller eye, small iris: shock), 'happy' (arcs bulging up), 'closed' (lines curving down, with a lash tick). Other names draw as 'open' |
| look | [0, 0] | iris offset, x and y in -1..1 (y positive looks down) |
| lid | 0 | 0..1, lowers the upper lid up to 45 % (tired, sad, sly) |
| brow | 0 | positive lifts the inner ends (worry, sadness, crying); negative pulls them down (anger) |
| browY | 0 | raises both brows by this many units |
| mouth | 'smile' | 'smile', 'soft', 'line', 'frown', 'grin' (teeth), 'open', 'shout'. Other names draw no mouth |
| open | .6 | 0..1, how far 'grin', 'open' and 'shout' open |
| tears | 0 | 0..1, two tear streams from under the eyes, 30 to 180 units long |
| wet | 0 | 0..1, watery shine on 'open' and 'wide' eyes (ignored for closed or happy eyes) |
| blush | 0 | 0..1, cheek blush with hatching |
| sweat | false | one sweat drop at the right temple |
| turn | 0 | -1..1, shifts face features and the cheek shadow sideways (hair does not move) |
| tilt | 0 | head and body rotation in degrees, around the eye line |
| shine | 1 | 0 hides the eye highlights (dead or hypnotised eyes) |

## FX helpers (`Anime.FX`)

- `speedLines(parent, cx, cy, r0, r1, n, color = '#fff', op = .5, seed = 1)`: focus lines aimed at (cx, cy) from radius r0 to r1. Returns a `<g>`; rotate it slowly for life.
- `streaks(parent, x, y, w, h, n, ang, color = '#fff', op = .6, seed = 2)`: parallel motion streaks in a box rotated by `ang`. Returns a `<g>`.
- `sparkle(parent, x, y, r, color = '#fff', op = 1)`: four-point star. Draw it at radius 1 and scale it with a transform to animate.
- `bokeh(parent, x, y, r, color, op = .4)`: soft circle with its own radial gradient. Returns the `<circle>`; move it with `cx`/`cy`.
- `tone(parent, color = '#000', size = 14, r = 2.4)`: screentone dot pattern. Returns a `url(#id)` for `fill`.
- `grain(parent, op = .08)`: a 1080 x 1920 noise rect. `blur(parent, sd)`: returns a `url(#id)` for a `filter` attribute.
- Building helpers: `lin(el, stops, x1, y1, x2, y2)` and `rad(el, stops, cx, cy, r)` return gradient urls (stops are `[offset, color, opacity]`);
  `clip(el, d)` returns a clip-path url; `rng(seed)` a seeded random function; `curvy(pts)` a soft closed path (a point `[x, y, 1]` stays sharp); `poly`, `P`.

## Minimal scene (from `examples/anime/scenes.js`)

```js
window.buildEpisode = (world, S) => {
  const { E, scene, ov, T } = S, { FX } = Anime;
  const LOOK = { hairStyle: 'swept', iris: '#3f63b0', irisL: '#a6d8ff', lash: 1, jaw: 0, shirt: '#f4a9bb', shirtS: '#d9849c' };
  // redraw every frame while the scene is on, and drop the <defs> the last frame made (see Gotchas)
  function live(sc, parent, fn) {
    const g = E('g', {}, parent), info = S.sceneById[sc.id];
    let made = [];
    S.ups.push(t => {
      if (t < info.start || t >= info.end) return;
      while (g.firstChild) g.firstChild.remove();
      made.forEach(d => d.remove());
      const before = new Set(sc.defs.children);
      fn(g, t);
      made = [...sc.defs.children].filter(d => !before.has(d));
    });
  }
  const sc = scene(world, 'joy', 'flash');
  E('rect', { width: 1080, height: 1920, fill: FX.rad(sc.cam, [[0, '#fff1c9'], [.45, '#ffb3c1'], [1, '#9c4d86']], .5, .45, .75) }, sc.cam);
  const lines = FX.speedLines(sc.cam, 540, 900, 380, 1600, 90, '#ffffff', .5, 3);
  S.during('joy', 'joye', t => lines.setAttribute('transform', `rotate(${(t * -6).toFixed(2)} 540 900)`));
  live(sc, sc.cam, (g, t) => {
    const cry = t >= T('L3e');
    new Anime.Bust(g, LOOK).draw(540, 960, 1.5, cry
      ? { eyes: 'closed', mouth: 'grin', open: .8, tears: 1, blush: 1, brow: .6 }
      : { eyes: 'wide', mouth: 'open', open: .7, wet: 1, tears: .15, blush: .5 });
  });
  ov(sc, 'ACCEPTED!', 'left:60px;right:60px;top:210px;text-align:center;color:#ffd166', 'stamp@L3', '', 'title');
  S.flashAt('L3', .9, .3);
};
```

## Gotchas

- `draw()` rebuilds the whole bust on every call, and every call adds new gradients and clip paths (about 8) to the first `<defs>` of the SVG. Nothing removes them. Redraw each frame inside `S.live(sc, (g, t) => ...)` from the core (or a layer like the one above, which also takes a parent group), or `<defs>` grows by hundreds per second of video.
- `draw()` empties only `bust.g`. If you clear the parent layer every frame, make a new `Bust` each frame (cheap) as the snippet does.
- No long hair. The three styles are short and any other name draws none. For long hair subclass `Anime.Bust` and override `hairBack(g, o)` (drawn over body and neck), `hairFront(g, o)` (over face and brows) and `foreheadShadow(fc, o)` (inside the face clip). `examples/anime` has a `Girl` class with long hair and bangs. Keep bang tips above y -76 so worried brows stay visible, and side locks outside x ±110 so they do not cut the lash wing.
- `wet` does nothing on 'closed' or 'happy' eyes. Tears always start under the eye centres and are drawn over the hair.
- 'wide' eyes shrink the iris: it reads as shock. For a teary happy look use 'open' with `wet: 1`, `tears`, `blush` and a 'grin'.
- `turn` moves only face features and the cheek shadow; hair, ears and body stay put. Keep it within ±.5.
- Busts have no arms. Draw hands as skin ellipses in front of the prop (see `hands()` in the example).
- An eye close-up is the same bust at scale about 3, clipped to a panel with `FX.clip` (the open scene of the example).
- The overflow check in `Short.start` only looks at elements with `data-fit`. SVG text on props is never checked: keep it inside x 60..1000 and out of the caption band y 1340..1560 by hand, then look at the sheet.
