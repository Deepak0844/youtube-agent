# The interview

Ask in rounds, in the user's language, with the question tool when there is one (up to 4 questions per call,
2 to 4 options each, your recommendation first and marked). Skip anything the user already answered.
After each round, say in one line what you understood. Write everything into `<series>/brief.md`.

## Round 1: what and why (always)

1. **Topic.** What is the video about? A story (a person, a team, an event), a how-to (a recipe, a trick),
   an explainer (a concept, a product), a list, a joke? Ask for the one sentence the viewer should remember.
2. **One video or a series?** A series fixes the format once (look, voice, intro, ending) and reuses it.
   If a series: working name, how many episodes to launch with, how often.
3. **Goal and tone.** Make people feel (emotional, epic), laugh, learn, or try something.
   Offer a mix: "80% emotion, 20% smile", "fun and fast", "calm and cosy", "sensational".
4. **Audience, language, platforms.** Who watches, which language for the voice and the captions
   (one language per video; a light accent is a choice, a caricature is not), and where it goes:
   YouTube Shorts, TikTok, Instagram Reels (all three take the same 9:16 file).

## Round 2: look and length (always)

5. **Visual style.** Show the gallery stills (`references/styles/*.jpg`) and describe each in one line:
   - **comic**: bold outlines, puppet characters with full bodies, action set pieces (sport, adventure, comedy)
   - **anime**: big-eyed busts, cel shading, sparkles and tears (emotion, drama, youth stories)
   - **manga**: thick ink, huge grins, fountain tears, hatching, sound words (hype, rivalry, comedy)
   - **paper**: torn cut-paper dioramas lit like a film, silhouettes (history, memory, poignant stories)
   - **painted**: soft storybook painting, clouds and hills, warm kitchens, glossy food (recipes, travel, cosy)
   - **kinetic**: big animated type and shapes, no characters (tips, numbers, lists, quotes); no style
     module and no gallery still: it is the template itself (`new_episode.py` without `--styles`)
   Styles can mix inside one video (e.g. painted world + kinetic numbers). Offer to render one test still
   in two candidate styles when the user cannot choose.
6. **Length.** 15 to 30 s (one idea, loops well), 30 to 60 s (a full mini story: the sweet spot),
   60 to 90 s (a recipe or a story with three beats). Under 60 s is safest for every platform.
7. **Narrator.** External voice in third person (storyteller), an invented character in first person (a cook,
   a coach, the hero), or text only with music. A real person is never the first-person narrator.
8. **Brand.** Series name or handle on screen? Colours or a logo to use? A recurring series tag?

## Round 3: voice and sound (always ask the voice)

9. **Voice engine.** Never assume it. OpenAI voices (best; needs the user's own API key; about 1.5 US cents
   per minute, see openai.com/api/pricing; the script text goes to OpenAI; platforms and OpenAI's policies ask you
   to say the voice is AI-generated), the computer's own voices (free, local, more robotic), or the user's own
   recordings (free, local; one file per line, `rec/line_00.wav`).
   OpenAI voices to suggest: `onyx` (deep, dramatic narrator), `coral` (warm, friendly), `nova` (bright),
   `sage` (calm), `ash` (casual), `ballad` (soft, storyteller). Describe the character in `instructions`:
   age, warmth, accent, energy. Offer to voice line 1 in two voices so the user can listen.
10. **Music feel.** Pick from the engine's moods (see `engine-api.md`): e.g. `rise` for momentum, `tense`
    for stakes, `tears` or `promise` for emotion, `triumph` for the payoff, `waltz` for cosy kitchens,
    `groove` for light fun. All music and effects are synthesized, so nothing needs a licence.

## Round 4: content rules (when it matters)

11. **Must be in, must stay out.** Facts, moments, quotes, names the user wants or refuses. Real people or
    brands involved? (respectful caricatures only, sourced facts, verbatim quotes, no logos, kits or characters of
    others: a fan-made line in the description does not make those fine)
12. **Ending.** A question to the audience ("which country next?"), a recap card to screenshot
    (how-tos: all ingredients and steps, hold about 5 s), a loop back into the opening, a follow CTA,
    or an indirect moral (show it, do not preach it). Series: make the ending a fixed ritual.
13. **Recurring pieces.** Intro card format (e.g. "Italy, Amatriciana: 25 min, 7 euros"), a series tag at the
    bottom, a watermark, a HUD (step counter, clock, score).

## Before moving on

Summarise the brief in 5 to 8 bullet lines and ask for a yes. Then research (if facts), then the story.
