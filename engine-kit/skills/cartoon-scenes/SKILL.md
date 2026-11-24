---
name: cartoon-scenes
description: How to write a cartoon scene (comic, anime, manga, paper and light, painted storybook) with the yt-toon kit - puppets, busts, set pieces, beat marks, the checklist every cartoon scene must pass, the rules the safety check enforces, and where the style guides and worked examples are. Use for any video whose style is cartoon_comic, cartoon_anime, cartoon_manga, cartoon_paper or cartoon_painted.
---

# cartoon-scenes - draw a cartoon video with yt-toon

A cartoon scene is ONE `.tsx` file (`scene/video.tsx`, or `scene/chNN.tsx` for a chapter of a long video) that imports the yt-toon kit.
The kit is cartoon-shorts' own drawing code as React components, so the look is exact; your job is the story, the staging and the timing.

## Read first (every time)

1. `ref/lib/toon.md`: every component and prop, generated from the kit. It is the truth; do not invent props.
2. `ref/cartoon-shorts/styles/<style>.md` for your style, and `ref/cartoon-shorts/storytelling.md`.
3. `ref/examples/cartoon-*`: finished scenes of the level of detail expected. Read the example for your style and at least one comic episode
   (`cartoon-upi-chai`, `cartoon-mango`, `cartoon-traffic`, `cartoon-docker`). Copy their structure, not their pictures.

## The shape of a file

```tsx
import { AbsoluteFill } from "remotion";
import { Scene, ToonFilm, Ov, Camera, useToon, clamp, eio, eout, lerp, trf } from "yt-toon/core";
import { Puppet, P, pose, mix } from "yt-toon/comic";

export const meta = { durationInFrames: N, fps: 30, width: 1080, height: 1920 };   // N and the size are given in the task

const Hook = () => {
  const { t, T, prog } = useToon();          // t = seconds, T("B3%50") = a mark in seconds, prog(t, "B3", "B4") = 0..1
  return (
    <Scene id="hook" tr="cut" words={[{ word: "PAID!", x: 360, y: 600, rot: -6, at: "B0%75", until: "B1" }]} overlays={<Ov css="left:0;right:120px;top:210px;text-align:center" cls="title" enter={[{ preset: "slam", at: 0.1 }]}>₹20</Ov>}>
      <Camera a="hook" b="hooke" from={1} to={1.05} />
      {/* SVG drawing: rects, paths, <Puppet>, set pieces ... in the order you want them stacked */}
      <Puppet options={{ ... }} act={(tt) => ({ pose: pose(P.stand, { face: "smile" }), x: 330, y: 1290, dir: 1, s: 1 })} />
    </Scene>
  );
};
export default function Film() {
  return (
    <AbsoluteFill>
      <ToonFilm scenes={[{ id: "hook", from: "B0", to: "B2" }, { id: "end", from: "B2", to: "B5e" }]}>
        <Hook />
        <End />
      </ToonFilm>
    </AbsoluteFill>
  );
}
```

- `ToonFilm scenes` says when each `<Scene id>` is on (beat marks). Scenes follow one another with no gap and the last one ends with the video (`B<last>e`).
  Put a cut a little before the next beat's first word ("B3-.3") so the picture is there when the word comes.
- A scene is SVG in the stage (1080 x 1920 portrait, 1920 x 1080 landscape) plus HTML text boxes (`<Ov>`), sound words (`words`), and `above` (SVG the camera does not move).
- Time-driven values (a number counting up, a door opening) are plain React: compute them from `t` in the scene component and put them in props.
  Puppets and busts take `act(t)`: a pure function of time that returns the pose.

## Beat marks

`B5` beat 5 starts, `B5e` ends, `B5%60` 60 percent in, `B5+.3` / `B5-.3` offsets, a scene id (`hook`) its start, `hooke` its end. The task says how many beats there are;
a mark past the last beat is refused by check_code. Key everything to beats, never to raw seconds (the voice is re-recorded sometimes and the picture must follow).

## Characters

- A series has a fixed cast in `input/cast.json`: draw those characters with `who="Name"` and never change their look; add minor one-off extras with `options={...}`.
  Without a cast file, invent the characters (original ones only; no characters, symbols or logos from any real series). On a series' first episode also write `cast.json` as the task says.
- Comic and painted draw whole bodies (`Puppet`, `Cook`); anime and manga draw busts (`Bust`); paper draws silhouettes (`Figure`, `Profile`).
- A prop in a hand: give the puppet an `id` and use `<Follow of="id" at="hand" place={(t, h) => [x, y, scale, rotation]}>` AFTER the puppet; show or hide it with `style={{ display: "none" }}` for the times it is not held.

## The rules the safety check enforces (they apply to your file)

- Imports: only react, remotion, and the yt-toon modules the task names. Named imports only, no renaming (so do not call your component `Scene`; the default export is `Film`).
- No `document`, `window`, canvas, timers, `Object`, `JSON`, `flatMap`, `sort`, `push`; no object spread except of a const object literal of this file (use `pose(a, b)` to merge poses);
  no `let` that holds anything but a number; keys in lists must be numbers (`key={i}`); `Array.from({ length: N })` needs a literal N (map over a literal array instead);
  `<small>`, `<img>`, `<style>`, `<canvas>` are refused (use `<span style={{...}}>`); props may not start with `on`.
- The file is at most 24 KB: keep helpers small, reuse components, and let the kit draw (set pieces, `words`) instead of writing paths.
- Gradient, pattern, clip-path and filter ids are shared by the whole film. A definition inside a hidden scene does not paint in the scene that is showing, so give every gradient an id that is
  UNIQUE per scene (`hook-sky`, `end-sky`), never the same id in two scenes. (Paper-style layers handle this themselves.)

## The checklist (every cartoon scene must pass it; check it on a still of every beat before you finish)

1. Every video gets its OWN story ending that pays off its topic: no shared rays + confetti + cheer finale. The last scene shows the idea resolved in a picture this topic only.
2. Sound words and bursts never cover faces or labels; phones never sit over faces; text stays inside the safe area and out of the caption band.
3. Characters walk forward in the direction they move (`dir`); nothing starts before its scene starts; nothing floats without a reason.
4. Keep facts and numbers exactly as the approved script says (names, prices, counts, units).
5. A story that reads with the sound off: one idea per scene, a clear before and after, the picture changes at the beat it is talked about.
6. Frame 0 already shows the first beat's picture at full strength.

## Landscape (long videos)

The stage is 1920 x 1080. Puppets and set pieces keep their size (same drawing code); lay the scene out wider: two or three characters side by side, a wide backdrop,
text boxes inside x 160..1760, nothing important in the bottom 220 px (captions).

## Sound

Read the suggest-sfx skill's engine section. When the sound library has `toon-*` sounds (comic ding, pop, whoosh, impact, ...) and music moods, cartoon styles prefer them; otherwise use the usual library.
Put a sound at the beat its picture happens (a DING at the `DING!` word, a whoosh at a scene cut).
