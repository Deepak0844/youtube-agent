# short-15 · Dev/networking — "The Internet In Eight Round Trips"

**New niche engine: `lib/network.tsx`** (not yet built — this is the DRAFT stage only). A
node‑and‑route diagram (client, DNS servers, web server) with an animated packet traveling the
path, paired with the existing `lib/browser.tsx` for the loaded‑page payoff shots. Seeds a
networking series (how a VPN hides your IP, what a CDN edge cache does, why HTTP/2 is faster,
what a firewall actually blocks).

## The promise

Hitting enter on a URL feels instant. It isn't "one step" — it's a messaging round trip to find
the right computer (DNS), a round trip to shake hands with it (TCP), a round trip to lock the
line (TLS), and only then the actual request and the page being built and painted onto your
screen. The video counts the trips.

## Facts (verified against sources actually fetched — see evidence.json)

- A DNS lookup is resolved hierarchically: the recursive resolver queries a **root name server**,
  which refers it to a **TLD name server** (e.g. the `.com` servers), which refers it to the
  domain's **authoritative name server**, which finally returns the IP address. — Wikipedia,
  *Domain Name System*.
- There are **thirteen groups of root name servers** globally, each replicated worldwide via
  anycast addressing. — Wikipedia, *Domain Name System*.
- Opening a TCP connection is a **three-way handshake** (SYN, SYN-ACK, ACK) — three messages back
  and forth before any request is sent. — MDN, *How browsers work*.
- An HTTPS connection adds a **TLS negotiation that takes five more round trips**, for a **total
  of eight round trips** before the browser can send the actual request. — MDN, *How browsers
  work* (direct quote: "After the eight round trips to the server, the browser is finally able to
  make the request.").
- To keep scrolling and animation smooth, a browser's style/layout/paint work on the main thread
  must complete in **under 16.67 milliseconds** — the frame budget for 60 frames per second.
  — MDN, *How browsers work*. (16.67ms = 1000ms ÷ 60fps, confirmed by arithmetic.)

**Access note:** Cloudflare's own DNS explainer pages (`cloudflare.com/learning/dns/...`)
returned HTTP 403 to the fetch tool used for this research (likely bot-blocking), so the DNS
chain is sourced from Wikipedia's *Domain Name System* article instead, which was fetched
directly and quoted. No instructions were found embedded in any fetched page.

## Beat sheet

| Beat | Time | On screen (real objects) | VO |
|------|------|---------------------------|----|
| HOOK | 0.0–4.9s | Frame 0 fully composed: a finished browser window (chrome + address bar) showing a loaded blog page, "dailybyte.com" — header, hero image block, article text lines. A thin, already-complete route ribbon glows faintly beneath it (laptop icon → DNS node → server rack icon). Stat chip "8 ROUND TRIPS" sits in the corner. | "Eight hidden trips across the internet — that's what hitting enter does." |
| SETUP | 4.9–16.5s | Canvas pulls back from the browser into a node diagram: laptop icon (client) with the typed address, a resolver node, a root-server node (chip: "13 ROOT SERVER GROUPS WORLDWIDE"), a `.com` TLD-server node, and the site's own authoritative-server node (small rack icon) — all connected by dashed paths. A packet dot travels resolver → root → `.com` → authoritative, then an "IP found" label flies back to the laptop. | "Your browser doesn't know where that is. It asks a resolver, which asks a root server, then a dot-com server, then the site's own server, for the real address." |
| REVEAL | 16.5–30.7s | Camera settles on just the laptop icon and the server-rack icon. A packet bounces laptop↔server three times, labeled SYN / SYN-ACK / ACK, counter ticking 1→3. A padlock icon starts assembling as five more bounces run, counter ticking 4→8. An "8" stamp lands with kicker "REQUEST NOT EVEN SENT YET." | "But before any of that page arrives, the two computers shake hands three times just to connect. Then five more times to lock it with encryption. Eight round trips, and the request still hasn't been sent." |
| TWIST | 30.7–38.6s | The server rack fires back a packet shaped like a small HTML-document icon. The browser window re-forms around it; tiny DOM-tree nodes assemble inside the page outline, then a paint-color sweep washes across it left to right. A ticking readout shows "60 FPS · 16.67 ms/frame." | "Finally, the server sends back the page's code. Your browser builds it and paints every pixel — sixty times a second." |
| LOOP | 38.6–42.0s | All diagram overlays dissolve away, landing exactly on the hook's finished browser window — last frame == frame 0. No CTA. | "All of that, before you've finished blinking." |

## Production notes

- **One persistent canvas**, camera-driven like short-8/11/12: it starts on the browser window,
  pulls back to reveal the network diagram behind/beneath it for the DNS and handshake beats, then
  pushes back into the browser for the render/paint payoff and the loop. No hard cuts.
- **New niche lib `lib/network.tsx`** (build in Stage 2, NOT built yet): simple node icons
  (laptop, server rack, a resolver/root/TLD/authoritative set of nodes), dashed connecting paths,
  and a traveling packet-dot component with a label that can read SYN/SYN-ACK/ACK/IP/HTML. Reuses
  `lib/browser.tsx` for the loaded-page shots — no changes needed there.
- The demo site is a **fictional** blog, "dailybyte.com" — chosen specifically as a `.com` domain
  so the spoken "a dot-com server" line matches what's on screen.
- TCP/TLS round trips are visualized as discrete bounces with a running counter (1→8) so the
  "eight round trips" payoff in the hook is something the viewer can verify by counting, not just
  a number asserted over narration.
- Ending is the payoff line ("before you've finished blinking") + seamless loop back to the
  resolved browser window. No engagement-CTA outro.

## VO (103 words, ~2.7 words/sec with slack; estimates until `gen_voice.py` runs)

| # | Beat | Start | End | Line |
|---|------|-------|-----|------|
| 1 | hook | 0.4 | 4.47 | Eight hidden trips across the internet — that's what hitting enter does. |
| 2 | setup | 4.9 | 7.49 | Your browser doesn't know where that is. |
| 3 | setup | 7.9 | 16.05 | It asks a resolver, which asks a root server, then a dot-com server, then the site's own server, for the real address. |
| 4 | reveal | 16.5 | 22.8 | But before any of that page arrives, the two computers shake hands three times just to connect. |
| 5 | reveal | 23.2 | 30.24 | Then five more times to lock it with encryption. Eight round trips, and the request still hasn't been sent. |
| 6 | twist | 30.7 | 38.1 | Finally, the server sends back the page's code. Your browser builds it and paints every pixel — sixty times a second. |
| 7 | loop | 38.6 | 41.2 | All of that, before you've finished blinking. |
