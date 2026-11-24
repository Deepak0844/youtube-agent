# Comic style (`engine/styles/toon.js` + `engine/styles/fx.js`)

![comic example](comic.jpg)

## What it looks like and what it suits

Bold 2D cartoon. Characters are SVG puppets with thick dark outlines (#17111b), flat skin with one shade, big
round eyes, expressive brows and mouths. Sets are flat gradients with comic set pieces: arena crowds, a wooden
court, a hoop with a swinging net, rain, flames, confetti, spinning rays, star bursts behind sound words.
Type is Anton for titles and Bangers for comic sound words ("CLANK!", "SWISH!").

Suits: sports stories, underdog arcs, comebacks, kids' stories, funny explainers with a character, anything with
a body in motion (shots, jumps, runs, falls). Less suited: quiet, abstract or data-heavy topics (try kinetic text
or painted), close-up emotional faces (try manga or anime).

Working example: `examples/comic/` (13.6 s, 5 lines, 3 scenes: miss, rain, final).

## Modules and load order

```html
<script src="timeline.js"></script>
<script src="../../engine/styles/toon.js"></script>   <!-- window.Toon -->
<script src="../../engine/styles/fx.js"></script>     <!-- window.FX; FX.cam calls Toon.track -->
<script src="../../engine/core.js"></script>
<script src="scenes.js"></script>
```

Keep `'400 100px Anton'` and `'400 100px Bangers'` in the `fonts` list of `Short.start`. The jersey number uses Anton.

## Toon: the puppet

`const kid = new Toon(parentG, look)` builds the rig in `kid.root` (a `<g>`). Nothing shows until `set()`.
`kid.set(pose, x, y, dir = 1, s = 1, time = 0)` redraws it and returns it. `x, y` is where it stands (lowest point of
feet or knees), `dir` 1 faces right, -1 faces left, `s` scales it, `time` drives the falling tear drops.
`kid.at(name)` gives the world point of a joint after the last `set`: `hand`, `fhand`, `head`, `neck`, `hip`, `foot`,
`ffoot`, `knee`, `elbow`, `shoulder`, `fshoulder`. Use it to put a ball or a prop in a hand.

Size at `s = 1`: an adult is about 540 px tall, `kid: true` about 360 px (limbs x0.6, wider head).

### Look options (constructor defaults)

| key | default | values |
|---|---|---|
| skin, skinD | '#8a5a3c', '#6a3f28' | skin and its shade |
| top | 'tank' | 'tank', 'tee', 'polo', 'shirt', 'suit' (suit takes `tie` colour) |
| shirt, shirtD, trim | '#7a1f3d', '#5a142c', '#ffb81c' | top colour, shade, neck and stripe trim |
| num, numFill | '23', '#ffb81c' | jersey number (`null` = none). Hidden when `turn` < .12 |
| legs | 'shorts' | 'shorts' or 'pants' (then `pants` colour); `shorts`, `shortsD` default to shirt |
| shoe, shoeD, sole, sock | white, grey, dark, white | `sock: null` for none; `stripe: false` hides the shorts stripe |
| hair, hairStyle | '#1c1412', 'short' | 'short', 'bald', 'puff', 'cornrows' |
| beard, headband, cap, glasses | false, null, null, null | colours (cap also takes `capD`) |
| sleeve, sleeveColor | null | 'near' or 'far': an arm sleeve |
| band, whistle | null, false | wrist band colour, a coach's whistle |
| kid, build, scale | false, 1, 1 | child proportions, body width, extra scale |
| back | false | seen from behind: hides the face |

### Pose format

A pose is a plain object of joint angles in degrees. Missing keys fall back to a neutral stand.
Limbs: 0 points down, +90 points forward (the way the character faces), 180 points up.
- `tor` forward lean, `hd` head tilt (+ = chin down).
- `nua`/`fua` upper arm (near/far), relative to the torso. `nfa`/`ffa` forearm, relative to the upper arm (+ bends forward).
- `nth`/`fth` thigh, `nsh`/`fsh` shin, relative to the thigh (- bends the knee back). `nft`/`fft` foot.
- `turn` 0 side view .. 1 front view (default .35). `lift` raises the body (jumps). `sq` squash and stretch (1 = none).
- `look` pupils -1..1, `blink` 0..1, `tears` 0..1 (streams plus drops), `open` 0..1 (shout mouth height).
- `face`: neutral, focus, grit, shout, roar, sad, cry, smile, grin, wow, worry. `hand`, `fhand`: 'fist' or 'open'.

Near limbs are drawn over the body, far limbs behind it. The near arm always stays in front, even when it swings back.

### Ready poses (`Toon.P`)

stand, ready, shoot, release, block, leap, layup, dunk, kneel, kneelFace, kneelRoar, roar, flex, celebrate, sit, sitSad,
carry, cradle, reach, point, hold, write, trophy. Combine: `Object.assign({}, Toon.P.stand, {face: 'sad', hd: 22, tears: .7})`.

### Motion helpers

- `Toon.mix(a, b, k)`: blends every number; `face`, `hand`, `fhand` switch at k = .5.
- `Toon.cycle(phase, amp = 1, kind = 'run')`: a pose for a walk, run or sprint cycle ('walk', 'run', 'sprint'). Advance `phase` by about 2*PI per stride.
- `Toon.track(keys)`: `[[seconds, value, ease], ...]` returns `t => value`. Value is a number, an array or a pose. The ease applies on the way into a key: lin, out, in, io (default), back, snap. Times are raw seconds: wrap them with `S.T('L3%50')`.
- `new Toon.Ball(parent, r = 24)` and `ball.set(x, y, rot, s, visible)`: an orange basketball with seams that spin with `rot`.

## FX: set pieces (all draw into an SVG group `g` and return what they made)

- `FX.svg(sceneDiv)`: a new full-frame svg prepended to the div, with `svg.defs`. `FX.g(parent, attrs)`: a group.
- `FX.lin(svg, [[offset, colour, opacity]], x1, y1, x2, y2)` and `FX.rad(svg, stops, cx, cy, r)`: gradient, returns `url(#id)`. `FX.dots(svg, colour, size, r, op)`: halftone pattern fill.
- `FX.rect(g, x, y, w, h, fill, attrs)`: a rect.
- `FX.cam(g, [[when, cx, cy, zoom, rot, ease], ...], fx = 540, fy = 860)`: moves `g` so (cx, cy) sits at (fx, fy). Times are S time expressions.
- `FX.rays(g, cx, cy, n, colour, op = .25, speed = 6, r = 2400)`: spinning sunburst, returns its group. Always on: wrap it in a group you hide.
- `FX.burst(g, cx, cy, r1, r2, n, fill, stroke, sw, seed)`: comic explosion star (inner r1, outer r2), returns the path.
- `FX.speed(g, cx, cy, rIn, rOut, n, colour, a, b, w)` radial speed lines; `FX.streaks(g, x0, x1, y0, y1, n, colour, a, b, speed)` horizontal streaks. Both show only in [a, b).
- `FX.confetti(g, a, b, colours, n = 140, x0, x1, y0, fall, seed)`: falls from above the frame in [a, b) and hides `g` outside it, so give it its own group.
- `FX.rain(g, a, b, n = 90, colour, seed)`, `FX.flames(g, cx, base, w, h, a, b)`: animated in [a, b).
- `FX.crowd(g, x0, x1, y0, rows, a, b, excite = .3, seed, dark = .55, palette)`: rows 58 px apart, bobbing heads, camera flashes. `excite` is a number or `t => 0..1`; above .5 raised arms show.
- `FX.court(svg, g, x0, x1, y, h = 760)`: wood floor band from y down.
- `FX.hoop(g, x, y, s = 1, flip = false)`: backboard, rim, net, pole. Faces left (flip faces right). Returns `{g, setNet(k), rim: [x - 35*s, y]}`. Call `setNet(k)` every frame: 0 rest, rising to 1 as the ball drops through.
- Props: `FX.stars(g, n, w, h, seed, op)`, `FX.skyline(g, x0, x1, base, colour, seed, hmin, hmax, lit)`, `FX.house(g, x, y, w, h, wall, roof, lit)` (`.win` is the window), `FX.streetlight(g, x, y, h, glow, svg)` (glow cone only when `svg` is passed), `FX.palm`, `FX.trophy(g, x, y, s)`, `FX.ring(g, x, y, s, label)`, `FX.jersey(g, x, y, s, colour, trim, num, numFill, sleeves)`, `FX.box`, `FX.desk`, `FX.football`, `FX.school` (`.sign` group for a label).
- `FX.popIn(el, when, dur = .35, cx, cy, from = 0)`: springy scale-in around (cx, cy); hidden before `when` when `from` is 0.

Animated pieces push an update into `Short.ups` and only redraw inside their window. Your own per-frame code does the
same: `S.ups.push(t => { ... })`. Updates run in the order they were pushed, so a later push can override a pose.

## Minimal scene (from examples/comic/scenes.js, trimmed)

```js
window.buildEpisode = (world, S) => {
  const { scene, ov, T, ups } = S, P = Toon.P;
  const sc = scene(world, 'final', 'zoom'), svg = sc.svg;
  FX.rect(svg, 0, 0, 1080, 1920, FX.lin(svg, [[0, '#07061a'], [.45, '#2a1446'], [1, '#120c1e']]));
  const W = FX.g(svg);                                   // world group, moved by the camera
  FX.crowd(W, -300, 1400, 470, 11, 'final', 'finale', t => t < T('L4') ? .35 : 1);
  FX.court(svg, W, -400, 1500, 1150, 900);
  const hoop = FX.hoop(W, 860, 640, 1), kid = new Toon(W, {kid: true, num: '7', shirt: '#e8343d', shirtD: '#b5222b'});
  const ball = new Toon.Ball(W, 30), hit = T('L4-0.02');
  ups.push(t => {
    if (t < T('final') || t >= T('finale')) return;
    kid.set(Object.assign({}, t < hit ? P.ready : P.celebrate, {face: t < hit ? 'focus' : 'grin'}), 300, 1290, 1, 1.6, t);
    const h = kid.at('hand');
    ball.set(h[0] + 8, h[1] - 24, 0, 1, t < hit);
    hoop.setNet(t > hit ? Math.min(1, (t - hit) / .45) : 0);
  });
  FX.cam(W, [['final', 520, 980, 1.14], [hit, 640, 880, 1, -2, 'out']]);
  FX.confetti(FX.g(svg), 'L4', 'finale', ['#ffd23f', '#e8343d', '#4fb3ff'], 150);
  ov(sc, 'SWISH!', 'left:0;right:140px;top:340px;text-align:center', 'smash@L4-0.02', 'L4-0.02..L4%55', 'boom');
  S.impact(hit); S.shake(hit, .5, 24); S.flashAt(hit + .1, .5, .25);
};
```

The full example adds a shot cycle (`shotPose`: rest, wind up with `P.shoot`, `P.release`, back to rest), ball
flight on a parabola, rim bounces with gravity, and `soundWord()` (an `FX.burst` plus a Bangers overlay).

## Gotchas

- `S.scene()` sets `svg.defs`, which `FX.lin`, `FX.rad`, `FX.dots`, `FX.court` and the streetlight glow need. A scene made another way needs `svg.defs = defs` before those calls.
- `FX.hoop` draws its pole down to `y + 1200 * s`: place the hoop high or cover the pole, or it runs through the caption band.
- `Toon.track` takes raw seconds. `FX.cam` converts time expressions itself, `Toon.track` does not.
- Blinks are not automatic: set `blink: 1` for about 3 frames every few seconds. Tear drops only fall if you pass `t` as the 6th argument of `set()`.
- `FX.rain`, `FX.flames` and `FX.crowd` stop updating outside [a, b) but stay visible, frozen. Hide their group yourself if the scene goes on.
- `FX.rays` spins for the whole video and has no window. `FX.popIn` overwrites the element's `transform` (put a base in `el.dataset.base`).
- The hoop pole runs down to `y + 1200*s`, through the caption zone. It is background, but keep caption text readable over it.
- Ball arcs: a jump shot releases high (hand near y 560 for a kid at scale 1.6 on floor 1290). An arc 260 px high hits titles at the top of the frame; 110 to 120 px was enough. Keep balls under a top scoreboard.
- Sound-word bursts are big (outer radius 1.25 x font size in the example). Keep them off the face, above all on an expression change.
- `S.impact(at)` inverts the frame for 3 frames. A flash at the same time washes it grey: put `S.flashAt` at `at + .1`.
- HTML overlays (`ov`) stay fixed while `FX.cam` moves the world group. Put text that must track the action in SVG inside the world group instead.
- Floor near y 1290 and `FX.cam` zoom: at zoom 1.2 the feet drop toward the captions (y 1340..1560). Check the zoomed frames.
