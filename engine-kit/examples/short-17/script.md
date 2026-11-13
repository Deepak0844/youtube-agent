# short-17 · Browser privacy — "It Never Left Your Laptop" (how an ad blocker actually works)

Format: 1080×1920 @ 30fps, 41s. 100% TSX. Reuses `remotion/src/lib/network.tsx` (`LaptopGlyph`,
`RackGlyph`/`ServerNodeGlyph`, `DashedConnector`, `PacketDot`) and `remotion/src/lib/browser.tsx`
(`WebBrowserFrame`) — **no new niche lib**, pure reuse of the short-15 networking kit plus the
short-8 browser kit. Voice: pending ElevenLabs key (timings below are estimates).

## The truth on screen

Not AI, not magic: a **filter list of URL patterns** (EasyList and its peers) is checked against
every outgoing request. A match cancels the request **before the browser even opens a connection**
— the ad server never sees it, so it never gets the chance to respond. Everything else on the page
(images, scripts that aren't on the list) loads and paints normally; only the matched slot stays
blank.

Facts (checked against sources below):
- An ad blocker "works by blocking communications to ad servers and then hiding the elements of
  the web page that are designed to display advertising content," using "filter lists containing
  the addresses of all known ad servers along with vast sequences of pattern matching rules."
  (publift.com)
- AdBlock "compares every HTTP (web page) request to the filter lists you're subscribed to," and
  on a match "the request is blocked, and the resource is not downloaded." For ads that never make
  a separate request (e.g. `data:` URIs), it instead "injects a stylesheet onto every web page"
  with `display: none !important` selectors — a second, cosmetic mechanism, not the main one.
  (helpcenter.getadblock.com)
- The blocking decision happens at the network layer, ahead of the request: Chrome's extension
  APIs intercept at `onBeforeRequest`, which fires "before any TCP connection happens," and the
  modern `declarativeNetRequest` API lets the browser "block requests natively before they leave
  the network stack." (developer.chrome.com / Chrome extension migration docs)
- EasyList — "the default filter subscription for most ad blockers," used by "uBlock Origin,
  Adblock Plus, AdGuard, Brave, Opera and Vivaldi" — is maintained by a named, small volunteer
  group ("Fanboy, MonztA, Khrin, and Yuki2718" per its README), where "the community can submit
  issues, the maintainers have final say." (hysenlabs.com)

## Beat sheet

| Beat | Time | On screen (real objects) | VO |
|------|------|---------------------------|----|
| HOOK | 0.4–4.1s | Finished state already composed: a browser window with a news page, one ad slot left as a blank dashed rectangle; a dim, unlit **server rack** glyph behind the page; a **laptop** glyph in front with its outbound **dashed connector** broken and stamped with a red ✕ partway along — the request stops at the laptop's own edge | "This ad didn't get deleted. It never left your laptop." |
| SETUP | 4.4–10.3s | Flashback/baseline: the SAME browser+laptop+rack canvas, but now three **server racks** (image / script / ad) each light up as a **packet dot** travels the dashed connector to them and back; the page paints in (text, image, and a bright ad box) as each response lands | "Load a page, and it quietly calls out to dozens of servers — for images, scripts, and ads." |
| REVEAL 1 | 10.7–15.9s | Camera pushes into a **filter-list panel** — a real document of mono-text rows (`\|\|doubleclick.net^`, `\|\|googlesyndication.com^`, `/ads/*`); the laptop's outgoing request URL scans down the rows, one row lights up as a match | "An extension checks every request's address against a filter list of known ad-server patterns." |
| REVEAL 2 | 16.2–21.8s | Cut back to the laptop/rack canvas: the matched packet never leaves — the **dashed connector** to the ad rack doesn't draw, a red ✕ stamps at the laptop's own edge, timed to "cancels"/"connection" | "The moment it matches, the browser cancels the request before it even opens a connection." |
| REVEAL 3 | 22.1–26.9s | The ad **server rack** stays fully dim/unlit while the image and script racks stay lit from SETUP; on the page, the ad rectangle stays blank/dashed, everything else stays painted | "The server on the other end never responds — because it was never asked." |
| TWIST 1 | 27.4–32.2s | Pull back from the filter-list panel: a plain-text document header reads "EasyList", with four small initials chips (Fanboy · MonztA · Khrin · Yuki2718) — explicitly no brain/AI icon anywhere in frame | "That list isn't AI. It's plain text, maintained by a handful of volunteers." |
| TWIST 2 | 32.5–35.8s | The same document stamps itself into three small name chips — "uBlock Origin", "Adblock Plus", "every major blocker" — reinforcing one shared list, many extensions | "Loaded into uBlock Origin, Adblock Plus, every major blocker." |
| LOOP | 36.3–38.5s→41s | Dissolve back onto the HOOK's exact frame — blank ad slot, dim rack, laptop, broken connector | "No request. No response. No ad." (payoff restated, no CTA) |

## Production notes

- One persistent canvas: laptop (foreground) + 3 server racks (background, labeled image/script/ad)
  + the page mockup inside a `WebBrowserFrame`, continuous across the whole video — SETUP shows the
  unblocked baseline, REVEAL shows the exact same wiring with one connector cut.
- The filter-list panel in REVEAL 1/TWIST is a camera push-in on a document layer, not a scene cut —
  keeps the "one continuous mechanism" feeling the niche demands.
- The blocked request must visibly stop **at the laptop's own edge**, never partway down the wire —
  that's the entire fact-checked point (blocked pre-connection, not a response that got hidden).
- No AI/brain/sparkle iconography anywhere near the filter-list panel — the twist's claim ("it isn't
  AI") has to be visually true, not just said.
- Ending is the payoff line + seamless loop. No engagement CTA.
