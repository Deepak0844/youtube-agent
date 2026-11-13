# short-13 · Algorithms — "A Million Numbers, Twenty Guesses" (binary search)

Format: 1080×1920 @ 30fps, 41s. 100% TSX. Reuses `remotion/src/lib/algo.tsx` (extended with
`binarySearchSteps`, `searchViewAt`, `RangeBoard`). Voice: pending ElevenLabs key (timings below
are estimates until `gen_voice.py` runs).

## The truth on screen

A REAL binary search over 1..1,000,000 for the hidden number **654,321** (chosen because it takes
the full worst case: exactly **20** guesses). Every guess, verdict, counter and the shrinking
interval is the algorithm's actual step — computed at module level, never hardcoded.

Facts (checked): ⌈log₂ 1,000,000⌉ = 20 (2²⁰ = 1,048,576) · ⌈log₂ 1,000,000,000⌉ = 30
(2³⁰ = 1,073,741,824) · linear scan worst case = 1,000,000 checks · binary search needs a SORTED list.

## Beat sheet

| Beat | Time | On screen | VO |
|------|------|-----------|----|
| HOOK | 0–3.4s | Finished game: minimap sliver, FOUND pill, counters GUESSES 20 / LEFT 1 | "A million numbers. Twenty guesses. That's all it takes." |
| SETUP | 3.4–14s | Board resets to 1..1,000,000. Linear scan sweeps the bar, counter races to 1,000,000 | "I'm thinking of a number… Guessing one by one could take a million tries. So guess the middle instead." |
| REVEAL | 14–31.9s | 20 real guesses: marker drops mid-interval, TOO LOW/HIGH verdict, losing half dims, bar zooms into the survivor. Pace accelerates (2s → 0.5s per guess) | "Five hundred thousand. Too low…" → "…on the twentieth guess, only one number left." |
| TWIST | 32–38.5s | Three stat chips: linear 1,000,000 / binary 20 / binary 1,000,000,000 → 30; "×2 numbers = +1 guess" | "Make it a billion? Just thirty guesses. Every doubling costs one guess." |
| LOOP | 39.6–41s | Dissolve back to the finished-game hook (grow 1→1.06 == hook's settle start) | "That's binary search." (payoff, no CTA) |

## Production notes

- One persistent board: the bar ALWAYS shows the live interval at full width, so 1,000,000 → 1 is a
  single continuous zoom; the minimap keeps the true scale (sliver shrinking inside 1…1,000,000).
- Guess durations: 60,60,42,42,30×6,15×10 frames — the accelerating montage is the "half, half, half".
- Ending is the payoff line + seamless loop. No engagement CTA.
