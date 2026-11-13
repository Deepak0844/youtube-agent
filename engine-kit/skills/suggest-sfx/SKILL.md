---
name: suggest-sfx
description: The sound pass of a short - read the beats, the real word times and the animation's exact frames, then write work/sfx-plan.json with a few tasteful sound effects and an optional music bed, synced to the visual beats and words, drawn only from the app's licensed library (list_assets). Use after the animation passes its frame check, when the task asks for a sound plan.
---

# suggest-sfx - the sound plan

Add tasteful sound effects, synced to the visual beats and the narration, drawn ONLY from the
app's library (`list_assets` with kind `sfx` or `music`). You write the plan; the app mixes it
under the voice, and the owner hears the result at the video approval.

House style (read `ref/brand/brand.md` section 7 every time): calm and premium, felt not heard,
always under the voice. Not loud, not trailer-like.

## Steps

1. Read brand.md section 7, the script's beats and word times, and your `scene/video.tsx`. Find
   the EXACT frame each visual beat happens (a piece lands, a digit pops, a badge stamps) and turn
   it into global seconds: `at_s = (local_frame + sequence_from) / 30`. Do not guess.
2. Pick sounds by their JOB: motion (whoosh), tension (riser), emphasis (impact, pop), snap
   (click). Key transitions and reveals only, plus the action sounds that ARE the content (piece
   thocks, digit pops). Layer only the 2-3 biggest moments (riser then impact, whoosh then pop).
   Mark deniable texture `"optional": true`.
3. `list_assets` for `sfx` (and `music` if a bed fits). Use only ids it returns. If the library
   has nothing that fits a cue, leave the cue out: never invent an id.
4. Write `sfx-plan.json` in the work folder (schema below). If the library is empty, write a plan
   with no events and say so in your summary.

## sfx-plan.json

```jsonc
{
  "events": [
    { "at_s": 4.9, "sfx_id": "<id from list_assets>", "gain_db": 0, "cue": "pawn lands (scene 2, local f51)" },
    { "at_s": 13.03, "sfx_id": "<id>", "gain_db": -3, "optional": true, "cue": "card locks" }
  ],
  "music": { "bed_id": "<id from list_assets or null>", "gain_db": -7 }
}
```

- `at_s`: seconds on the video's timeline (same clock as the word times).
- `gain_db`: relative to the clip's normalised level. Under a short's near-continuous narration
  start at: transitions and whooshes -3, story pops and impacts 0 to +3, stamps and snaps 0 to +7,
  hero risers 0 to +2.
- `cue`: the exact frame or word, so the owner can read the plan.

## Principles

- Under the voice, always; silence is part of the mix.
- Sync to the visual beat AND the word: off by 100 ms reads as sloppy.
- Function over vibe; the same few sounds do the heavy lifting; more is not better.
- A cue that sits fully under continuous speech will not be heard: put it in a word gap or cut it.
- No static, glitch or hum textures under narration.
