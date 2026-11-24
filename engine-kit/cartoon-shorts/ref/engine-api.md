# Engine API

An episode is a folder: `short.json` (script, voice, sound), `short.html` (page and look), `scenes.js` (drawing),
`post.json` (upload texts). `audio.py` turns `short.json` into audio and `timeline.js`; the page reads the
timeline, `render.mjs` seeks the page frame by frame and encodes. The frame is 1080 x 1920 at 30 fps.

## short.json

| key | default | meaning |
|---|---|---|
| `voice` | macOS/espeak | `{"engine": "openai", "model": "gpt-4o-mini-tts", "voice": "coral", "tempo": 1.2, "instructions": "..."}`, `{"engine": "say", "voice": "Samantha", "rate": 185}`, `{"engine": "espeak", "voice": "en-us", "rate": 165}`, `{"engine": "file", "dir": "rec", "tempo": 1.0}` |
| `fallback` | macOS/espeak | voice used when the main one fails (no key, network) |
| `lang` | `en` | language of the captions and of the Whisper check |
| `lead` | 0.1 | silence before line 0 |
| `gap` | 0.14 | silence between lines |
| `scene_gap` | 0.25 | extra silence when the scene changes |
| `end_hold` | 2.0 | seconds after the last line |
| `cut_lead` | `{}` | per scene: where the cut falls between the previous line's end (0) and this line's start (1), default 0.4 |
| `music_gain`, `fx_gain`, `amb_gain` | .5, .45, .3 | mix levels; keep music at .25 to .35 under a voice |
| `score` | `[]` | `[[when, mood, energy], ...]`: each mood plays until the next entry |
| `sfx` | `[]` | `[[when, effect, gain], ...]` one-shot effects |
| `amb` | `[]` | `[[from, to, bed, level, excite], ...]` ambience beds, ducked with the music |
| `no_whoosh` | `[]` | scene ids that do not get the automatic whoosh on their cut |
| `lines` | | the script, see below |

Each line: `scene` (id: lowercase, digits, underscore), `say`, `cap` (caption, `*stars*` highlight, `null` = none),
optional `inst` (OpenAI delivery notes, replaces `instructions` for this line, so repeat the character
description in it), `tempo`, `after` (pause after), `pause` (extra pause before).

Voice clips are cached by text and settings: editing one line re-voices only that line.
OpenAI clips vary a little in length on each request, so timing can shift after a re-voice; everything
keyed to lines follows by itself.

**Score moods**: `tense`, `sad`, `warm`, `home`, `tears`, `promise` (soft emotional family), `rise`, `groove`
(momentum, light fun), `drop` (sudden hit), `epic` (big drums), `slowmo`, `triumph`, `end` (final chord),
`waltz` (cosy 3/4 kitchen waltz), `silence`.
**Effects**: `whoosh`, `whip`, `impact`, `hit`, `swish`, `bounce`, `squeak`, `buzzer`, `rewind`, `tapestop`,
`flash`, `typewriter`, `ding` (small bell), `bell` (school bell ringing), `sparkle`, `fire`, `riser`, `riser3`, `heartbeat`, `kick`, `taiko`,
`cymbal`, `sub`, `pop`, `tick`, `trumpet` (fanfare call), `toll` (slow church bell), `chop`, `chops`, `splash`, `pour`, `plop`, `salt`,
and short one-shot versions of the beds: `sizzle`, `boil`, `crowd`, `rain`, `wind`.
Do not fire `S.flashAt` at the same moment as `S.impact`: the flash washes the inverted frame to grey (put it 0.1 s later).
**Beds**: `crowd` (level, excite 0..1), `rain`, `wind`, `drone`, `fire`, `sizzle`, `boil`.

## Times

Everywhere (short.json, data attributes, JS helpers) a time can be:
`2.5` seconds | `L3` line 3 starts | `L3e` line 3 ends | `L3%40` 40% into line 3 | `L3+.2`, `L3e-.3` offsets |
`hook` scene starts | `hooke` scene ends | `hook+1.2` | `S2` the third scene starts.
Key everything to lines, never to raw seconds (except the first 0.1 s of the video).

## The page (short.html)

Loads Google Fonts, `engine/core.css`, `timeline.js`, the style modules, `engine/core.js`, `scenes.js`, then:
```js
Short.start(async () => buildEpisode(document.getElementById('world'), Short), {fonts: ['400 100px Anton']});
```
Fixed layers inside `#v`: `#world` (scenes), `#flash`, `#vig` (vignette), `#grain` (film grain), `#cap` (captions).
Restyle captions and colours in the page's own `<style>` (see `examples/painted/short.html` for a soft look).

## scenes.js

```js
window.buildEpisode = (world, S) => {
  const { E, tr, scene, ov, camera, during, prog, eout, eio, clamp } = S;
  const sc = scene(world, 'hook', 'cut');          // transitions: cut | zoom | whip | flash | glitch
  E('rect', {width: 1080, height: 1920, fill: '#223'}, sc.cam);   // SVG drawing goes in sc.cam
  const sun = E('circle', {r: 120, fill: '#fc3'}, sc.cam);
  during('hook', 'hooke', (t, k) => tr(sun, 540, 800 - 200 * eout(k)));  // per-frame update in a window
  ov(sc, 'BIG TITLE', 'left:0;right:0;top:300px;text-align:center', 'slam@L0+.1', '', 'title');
  camera(sc);                                       // slow push over the whole scene
  S.shake('L1%50', .4, 24);
};
```
- `scene(world, id, transition)` returns `{id, div, svg, defs, cam}`. The scene is visible only between its start
  and the next scene's start (from the timeline). Its id must exist in short.json.
- `ov(sc, html, css, k, on, cls)` adds an absolutely placed HTML element (text, cards) on top of the SVG. The html is
  trusted markup only: names, quotes and titles from research or the user go through `S.esc(text)`, or use
  `ovText(sc, text, css, k, on, cls)`, which sets plain text. Captions are escaped by the engine.
- `E(tag, attrs, parent)` makes an SVG element; `tr(el, x, y, scale, rot)` sets its transform.
- `live(sc, fn(g, t), a, b)` redraws layer `g` from scratch on every frame of the scene (use it for busts and
  props whose `draw()` rebuilds the SVG; it also clears the clip paths the previous frame left in `<defs>`).
- `during(a, b, fn(t, k))` runs fn on every frame between two times (k = 0..1); `prog(t, a, b)` = progress.
- `camera(sc, a, b, from, to, cx, cy)` zooms `sc.cam` slowly (it owns `sc.cam`'s transform: never combine it with a style's own camera on the same group); `S.counter(fn, from, to, at, dur)` counts numbers;
  `S.typer(el, text, at, cps)` types text.
- `S.shake(at, dur, amp)`, `S.flashAt(at, opacity, dur)`, `S.impact(at, frames)` (inverted frame + colour split),
  `S.chroma(at, dur, px)`, `S.filter(at, dur, css)` act on the whole frame.
- Markup presets on any element: `data-k="slam@L2 out@L3e:0.2"`: `slam`, `smash`, `up`, `down`, `left`,
  `right`, `fade`, `out`, `pop`, `stamp`, `growx`, `growy`, `nudge`, `wipe` (optional duration after `:`).
  `data-on="L2..L3e"` shows an element only in that window.
- Add `data-fit` to a text box: the renderer warns when its text overflows.
- Everything must be a pure function of time: `seek(t)` can be called in any order (parallel workers render
  different frames). Never use `Math.random()` (use a seeded rng from a style module) or `Date.now()`.

## CSS classes from core.css

`.title` (huge outlined type), `.boom` (comic sound word), `.kicker` (small caps over a title), `.pill`
(label on a coloured tag), `.panel` (framed comic panel), `.label`, `.src` (source line). Episode pages
override `--ink`, `--paper`, `--gold`, `--red`, `--sky`, `--green` and the fonts.

## Safe areas (1080 x 1920)

- Action and titles: x 60 to 1000, y 200 to 1300.
- Captions: y 1340 to 1560 (keep other text out of this band).
- Covered by the platforms: right edge (about 120 px: like, comment, share buttons) and the bottom
  (about 300 px: account name, caption text, music). Keep nothing important there.

## render.mjs

```
node engine/render.mjs <ep> still 0.5 3 7.2     # PNG stills in <ep>/stills/ (DSF=2 for 2160 x 3840)
node engine/render.mjs <ep> sheet 2              # contact sheet, a frame every 2 s, 6 across
node engine/render.mjs <ep> full [fps]           # <ep>/out/<ep>.mp4
```
Env: `WORKERS` (parallel Chromes for full, default 4), `HIDE='#cap'` (hide elements, e.g. captions on a
thumbnail), `OUT=<file>`, `PAGE=<other.html>`, `CHROME_PATH`. It warns when a font did not load or a
`data-fit` box overflows, and prints page errors at the end.
