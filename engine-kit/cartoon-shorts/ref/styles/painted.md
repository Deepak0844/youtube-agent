# Painted storybook style (`engine/styles/painted.js`, `window.Painted`)

![painted](painted.jpg)

## What it looks like and what it suits

A soft, hand-painted storybook look. Big cumulus clouds, layered green hills with a village and sheep,
a warm kitchen with window light, gingham curtains and majolica tiles, and a round, friendly cook.
Outlines are thin and warm brown (`INK = '#4a2e20'`), never black. Food is glossy: rich colours,
soft gradients, white highlights.

It suits recipes, cooking and food series, cosy explainers, travel and "a day in the village" stories,
and anything for a family audience. It does not suit fast action, hard news or tech topics.

Working example: `examples/painted/` (tomato pasta, 3 scenes, 4 lines, about 14.6 s).

## Modules and load order

```html
<script src="timeline.js"></script>
<!-- optional: only for the paper grain overlay, Paper.paperTile(); paper.js needs toon.js first -->
<script src="../../engine/styles/toon.js"></script>
<script src="../../engine/styles/paper.js"></script>
<script src="../../engine/styles/painted.js"></script>
<script src="../../engine/core.js"></script>
<script src="scenes.js"></script>
```

painted.js has no dependencies. Fonts that fit: Fraunces italic 900 (titles) and Nunito 800/900 (labels, captions).
Restyle `#cap` in short.html (Nunito, no uppercase, cream fill with a brown stroke); copy the `<style>` block of the example.

## API cheat-sheet

All drawing functions take a parent SVG element `p` first and append to it. Times are seconds.

Helpers
- `E(tag, attrs, parent)` SVG element. `st(w, color)` stroke attrs in INK (widths up to 10 are halved).
- `lin(el, [[offset, color, opacity?], ...], x1=0, y1=0, x2=0, y2=1)` and `rad(el, stops, cx=.5, cy=.5, r=.5)` add a gradient to the svg's defs, return `'url(#id)'`.
- `blur(el, sd)` returns a cached `url(#id)` blur filter. `clip(el, {tag, a})` returns a `url(#id)` clip path.
- `rng(seed)` seeded random, returns a function. `clamp`, `eout`, `eio`, `mix(hexA, hexB, k)` colour blend (6-digit hex only).
- `tr(el, x, y, s=1, r=0)` sets translate/rotate/scale. x, y and r must be numbers (it calls `toFixed`).
- `scene(world, id, trn)` returns `{id, div, svg, defs, cam}` (same as `S.scene`). `INK` the outline colour.

Sets
- `landscape(p, {sheepOn=true, seed=3})` full 1080 x 1920 meadow: sky, sun glow, 4 clouds, mountains, hills, village at (540, 1062), flowers, sheep. Returns `update(t)`, a function (clouds drift, sheep hop).
- `kitchen(p, {counterY=1240})` wall, ceiling beam, window (x 520..980, y 230..790) with a live landscape inside, curtains, shelf with pots and jars (left, y about 450..545), a hanging guanciale and salami (x 150..280, y 60..400), a tile row at `counterY - 150`, warm light. Returns `{g, update(t)}`. It does not draw the counter.
- `counter(p, y=1240)` wooden counter top and front from `y` to the bottom. Returns the group. Draw it after the cook so it hides the cook's legs.
- `cloud(p, x, y, s=1, seed=1)`, `sheep(p, x, y, s=1, flip=1)`, `village(p, x, y, s=1)` each return a group.

The cook
- `Cook(p, {x=540, y=900, s=1, skin, hair, top, apron, trim})` returns `{g, hands, set(o)}`. At s=1 the hair top is about y-362, the shoulders are at (x±142, y+80), the body is ±226 wide and ends at y+640. Arms: upper 160, forearm 150.
- `set({la=[18,-60], ra=[18,-60], headR=0, talk=0, blink=false, happy=false, point=null, bob=0, lean=0})`. `la`/`ra` = `[a1, a2]` in degrees: a1 swings the upper arm out from straight down, a2 bends the elbow. Arms up: `[150, 50]`. `talk` 0..1 opens the mouth, `happy` or `blink` closes the eyes into arcs, `point: 'l'|'r'` shows a pointing finger, `bob` moves it down in px, `lean` rotates it.
- After `set`, `hands.l` / `hands.r` are `[x, y]` in the cook's own frame. World position: `x + s * hx`, `y + bob + s * hy`. Use it to put a spoon in the hand.
- `talkAt(t)` 0..1 mouth amount while any voice line plays (syllable flutter). `blinkAt(t)` true for 0.13 s every 3.4 s.

Food and tools in `Painted.F` (drawn around 0,0, about 200 px wide; wrap them in a translated `<g>` to place them)
- `F.tomato(p, r=34)` glossy tomato. `F.garlic(p)`, `F.onion(p)`, `F.bacon(p)`, `F.pecorino(p)` (wedge), `F.can(p)` (tomato tin), `F.spaghetti(p)` (dry pack): each returns `g`.
- `F.guanciale(p, s=1)` cured slab, returns `g`. `F.strip(p, s=1)` one strip, returns `{g, cook(k)}`: k 0..1 goes from raw to golden.
- `F.bottle(p, glass='#4f8a4a', label='#f4ead2', s=1)`, `F.pepper(p, s=1)` (mill), `F.corns(p, n=9, seed=3)`, `F.salt(p, s=1)` (pinching fingers; animate the grains yourself): return `g`.
- `F.pan(p, s=1)` iron pan seen from above, ellipse rx 340, ry 160, handle to x +664. Returns `{g, inside}`; `inside` is clipped to the pan, put oil, sauce and food there.
- `F.pot(p)` stock pot, about x ±300, y -206..210. Returns `{g, water}`; `water` is clipped to the surface (add bubbles there).
- `F.flames(p)` blue gas ring, returns `{g, update(t)}`. `F.bowl(p)` returns `{g, inside, front}`.
- `F.plate(p, rx=250, ry=100)` white plate with a blue band and a soft shadow, returns `g`.
- `F.nest(p, {w=230, h=90, seed=4, sauce=false})` a heap of many thin strands, returns `g`. `F.twirl(p, {w, h, seed=6, sauce=true})` a fork lifting a twirl, returns `{g, update(lift)}`.
- `F.steam(p, x, y, n=3, s=1)` soft wisps, returns `{g, update(t, amt=1)}`; amt 0..1 scales the opacity. Call `update` every frame.

## Minimal scene (from the example)

```js
window.buildEpisode = (world, S) => {
  const { E, tr, scene, ov, during, clamp, eout, T } = S;
  const P = window.Painted, { F, Cook, talkAt, blinkAt } = P;
  const at = (t, a, b) => clamp((t - T(a)) / (T(b) - T(a)));
  const sc = scene(world, 'kitchen', 'whip');          // core scene: it has the id that camera() needs
  const kit = P.kitchen(sc.cam);
  const cook = Cook(sc.cam, { x: 270, y: 800, s: .9 });
  P.counter(sc.cam, 1240);                             // after the cook
  const pan = F.pan(E('g', { transform: 'translate(540,1250) scale(.55)' }, sc.cam));
  const tom = E('g', {}, sc.cam); F.tomato(tom, 44);
  const steam = F.steam(sc.cam, 540, 1160, 3, 1);
  ov(sc, '<div class="step"><i>1</i><span>Garlic, oil, tomatoes</span></div>', 'left:60px;top:130px', 'left@kitchen+.1');
  during('kitchen', 'kitchene', (t, k) => {
    kit.update(t);
    cook.set({ ra: [34 + Math.sin(t * 7) * 7, -6], talk: talkAt(t), blink: blinkAt(t), bob: Math.sin(t * 2.2) * 3 });
    const a = at(t, 'L1%60', 'L1%72');
    tr(tom, 470, 820 + 420 * a, 1 - .4 * a, a * 90);
    tom.style.display = a > 0 && a < 1 ? '' : 'none';
    steam.update(t, 1);
  });
};
```

For pasta on a hero plate, the example has its own `pastaNest(p, {w, h, turns, seed, basil})`: one spiral of
a few broad glossy bands (back half-turns drawn first, then the front ones bottom to top) over a shaded mound,
with a glossy sauce pool, tomato chunks and basil on top. Copy it from `examples/painted/scenes.js`.

## Gotchas

- `landscape()` returns a bare `update(t)` function, `kitchen()` returns `{g, update}`. Call both every frame inside `during`, or the clouds freeze.
- The head tilt option of `Cook.set` is `headR` (degrees).
- `talkAt` opens the mouth on every voice line. With two speakers, pass `talk: 0` when the cook is not the one talking.
- `F.nest` is a tangle of thin strands. For a big, painted-looking plate use broad bands (the example's `pastaNest`).
- The kitchen always shows a guanciale and a salami on hooks and a mountain village in the window: fine for Italian food, odd elsewhere. Cover them or build your own wall.
- Most F props take no x, y: draw them into `E('g', {transform: 'translate(x,y) scale(s)'}, parent)`.
- `F.pan` has a long handle: at scale .55 centred at x 540 it reaches x 905. Keep the pan left of centre.
- A `data-k` preset hides the element until it starts (the first preset fills backwards). For text that must be readable at frame 0, use no preset or `nudge`.
- Steam rises about 240 px times its scale: start it low or it covers the cook's face.
- Keep text inside x 60..1000 and out of the caption band y 1340..1560. The counter front below y 1290 is a good calm area under the captions.
- `kitchen(p, {hang: false})` hides the cured meats on hooks (they suit an Italian kitchen, not every country).
- `F.nest` draws many thin strands. For an inviting plate draw a few broad glossy bands with sauce on top (see `pastaNest` in `examples/painted/scenes.js`).
