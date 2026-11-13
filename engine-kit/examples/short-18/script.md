# short-18 · Dev/AI — "The Window Never Grows" (how an LLM's context window actually works)

Format: 1080×1920 @ 30fps, 41s. 100% TSX. **New niche engine: `lib/chatui.tsx`** (not yet built —
this is the DRAFT stage only): a phone/laptop chat thread of message bubbles, a glowing
fixed-width "window" frame overlaid on it, and a token-strip (small blocks, algo.tsx-style) with a
sliding highlighted range + live token counter. Seeds an **AI-mechanics series** (next-token
prediction, embeddings, hallucination, prompt caching — TOPICS.md days 8/9/27).

**Note on the same topic elsewhere in this repo:** `ai-shorts/ai-3-ai-chatbot-suddenly/` already
shipped this exact title on the generative (blue-man) track, using a workshop/scroll/chute prop
metaphor. This draft is a deliberate second treatment of the same facts for the 100%-TSX track —
a chat UI + bounded window-frame + token strip, not a prop. Facts below were re-verified directly
by this session (not copied from that draft), though they land on the same sources.

## The truth on screen

A model's context window is a **fixed architectural ceiling** — the maximum number of tokens
(sub-word text units) it can hold as "working memory" for a request, set by the model, not the
conversation. It does not grow as a chat gets longer. Every single turn, the app resends the
**entire** conversation history (within that ceiling) as fresh input — the model has no memory
between calls, only whatever is handed to it again. Once a long-running chat fills that ceiling,
most chat products manage it with a **sliding window**: the oldest turns are evicted
first-in-first-out to make room for new ones, silently, with no warning to the user — the message
isn't summarized or faded, it's just gone. And the catch ai-3 also found: even text still *inside*
the window isn't perfectly safe — real research shows models don't use their context uniformly,
and recall quietly gets less reliable the further back a detail sits, well before the window is
even full.

Facts (checked against sources actually fetched this session — see evidence.json):
- A context window is a hard ceiling fixed by the model; e.g. GPT-4o's is a flat **128,000
  tokens** (developers.openai.com).
- Each API turn's input contains "all previous conversation history plus the current user
  message" — the model is handed the whole transcript again every time, not recalling it
  internally (platform.claude.com, *Context windows*).
- A token is "a character, part of a word, a whole word, or punctuation," and roughly **100
  tokens ≈ 75 words** (help.openai.com, *Understanding and counting tokens* — fetched via search
  synthesis; a direct `WebFetch` to that URL returned HTTP 403, likely bot-blocking, same class of
  access issue short-15 hit on Cloudflare).
- Derived: 128,000 tokens × 0.75 words/token ≈ **96,000 words** (`128000 * 0.75`).
- "As new turns arrive, the oldest turns are evicted first-in-first-out, so the window is always
  full of recent text" — most chat products' standard overflow handling, and "the model never
  tells you they're gone" (ai-tldr.dev, *What Happens When You Exceed the Context Window?*).
- Silent truncation specifically: "The reply looks confident and complete while missing half the
  context" — users aren't notified (ai-tldr.dev, same page).
- "Large Language Models (LLMs) are typically presumed to process context uniformly... However, in
  practice, this assumption does not hold" — and performance "degrades more quickly ... as input
  length increases," even far below a model's stated maximum (trychroma.com, *Context Rot*
  research report, 18 frontier models tested).

## Beat sheet

| Beat | Time | On screen (real objects) | VO |
|------|------|---------------------------|----|
| HOOK | 0.4–4.47s | Frame 0 fully composed: a phone's chat UI, message bubbles scrolled deep (hundreds of messages implied by a long scrollbar), a glowing rectangular **window frame** overlaid on only the newest ~6 bubbles — fixed width, already snapped to size. One early bubble ("my dog's name is Max") sits faded/outside the frame's upper edge. | "Your chat window never grows, not even after ten thousand messages." |
| SETUP | 4.77–16.18s | Camera holds on the phone: with every new bubble that lands, the ENTIRE stack of bubbles inside the frame briefly re-highlights top-to-bottom (showing it's being resent, not recalled). A small label stamps "RESENT EVERY TURN." The glowing window frame itself gets a stat chip: "CONTEXT WINDOW — FIXED SIZE, MEASURED IN TOKENS." | "Each time you hit send, the model doesn't recall the chat — it rereads the whole thing, every turn. That reread has a hard limit: a context window, measured in tokens." |
| REVEAL 1 | 16.48–23.52s | Camera pushes into a **token-strip** beneath the phone: a long row of small token blocks (algo.tsx-style cells) with a highlighted window of fixed width sliding right; a counter reads "128,000 / 128,000 TOKENS." As it ticks full, the leftmost block in the highlighted range dissolves (not fades — a clean dematerialize) exactly as a new block enters on the right. A chip reads "≈96,000 WORDS." | "Once it's full, the oldest messages get pushed out automatically — gone, not faded, to make room for new ones." |
| REVEAL 2 | 23.82–29.75s | Still on the token strip: blocks near the trailing (but still inside) edge of the highlighted window begin a slow desaturate/dim gradient, distinct from the clean dissolve of evicted blocks — a chip reads "RELIABILITY DROPS PAST ~2,500 WORDS." | "But even messages still inside that window quietly get less reliable, the further back they sit." |
| TWIST | 30.05–36.35s | Split composition: left side shows the phone's full scrollable chat log (user can scroll up through every old bubble, nothing deleted on screen); right side shows the same thread cropped hard to the glowing window frame — only a handful of bubbles exist inside it. A label stamps "WHAT YOU SEE" vs "WHAT IT SEES." | "Your screen still shows everything. The model already forgot some of it, and barely trusts the rest." |
| LOOP | 36.65–39.61s→41s | Dissolve back onto the HOOK's exact frame — same window frame, same six bubbles, same faded "Max" bubble outside it. Last frame == frame 0. | "The window never grows. That's why it forgets." (payoff, no CTA) |

## Production notes

- **One persistent canvas**: a phone chat UI (foreground) with the glowing window-frame overlay,
  and a token-strip layer that the camera pushes into for REVEAL 1/2 — no hard scene cuts, same
  camera-driven continuity as short-8/11/15/17.
- **New niche lib `lib/chatui.tsx`** (build in Stage 2, not built yet): `ChatBubble`,
  `WindowFrame` (fixed-width glowing rect overlay), `TokenStrip` (array of cells + sliding
  highlighted range + live counter), and an `evict`/`dim` transition pair — eviction is a clean
  dissolve (brand §7: no glitch/static under narration), context-rot is a slow opacity/desaturate
  ramp, and the two must look visually distinct from each other since the twist's whole point is
  that they are two different mechanisms.
- The REVEAL's token counter and the "≈96,000 words" chip are the SAME arithmetic the VO never
  states aloud (128,000 × 0.75) — grounds the visual without over-loading the narration.
- The TWIST's split "what you see / what it sees" must be literal and simultaneous on screen, not
  sequential cuts — that contrast is the entire argument of the video.
- Ending is the payoff line + seamless loop back to the hook's exact frame. No engagement CTA.

## VO (101 words, ~2.7 words/sec with slack; estimates until `gen_voice.py` runs)

| # | Beat | Start | End | Line |
|---|------|-------|-----|------|
| 1 | hook | 0.4 | 4.47 | Your chat window never grows, not even after ten thousand messages. |
| 2 | setup | 4.77 | 11.44 | Each time you hit send, the model doesn't recall the chat — it rereads the whole thing, every turn. |
| 3 | setup | 11.74 | 16.18 | That reread has a hard limit: a context window, measured in tokens. |
| 4 | reveal | 16.48 | 23.52 | Once it's full, the oldest messages get pushed out automatically — gone, not faded, to make room for new ones. |
| 5 | reveal | 23.82 | 29.75 | But even messages still inside that window quietly get less reliable, the further back they sit. |
| 6 | twist | 30.05 | 36.35 | Your screen still shows everything. The model already forgot some of it, and barely trusts the rest. |
| 7 | loop | 36.65 | 39.61 | The window never grows. That's why it forgets. |
