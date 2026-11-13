# short-19 · Dev/tech explainer — "Plugged In, Not Charging — On Purpose" (bypass charging)

Format: 1080×1920 @ 30fps, 38s. 100% TSX. New niche: consumer-electronics mechanism explainer.
Needs a small new prop set (phone body, charger brick, battery-cell icon, CPU chip, switch/relay) —
none of the existing `techprops.tsx` SVGs (laptop/server/container/cloud) fit; add a `lib/power.tsx`
or extend `techprops.tsx`. Voice: pending ElevenLabs key (timings below are ~2.7 words/sec estimates).

## The truth on screen

Bypass charging is real, shipped tech — not a rumor or a jailbreak trick. A power-management
chip can reroute the charger's power straight to the processor and screen instead of through the
battery, so the battery neither charges nor discharges while the device is plugged in and under
load. The clearest, best-documented consumer implementation is Samsung's **"Pause USB Power
Delivery"** on Galaxy phones: plug in a 25W+ PPS charger, keep the battery above 20%, start a game,
and the system stops cycling the battery for that session.

**Scope decision:** gaming-laptop forums (HP Omen, Lenovo Legion, ASUS ROG) show users asking for
this, but a dedicated battery-tech source states laptops do **not** fully bypass the battery the
way phones can, and Framework's own community confirms their BIOS "disconnect battery" option is
for safe internals work, not true bypass-while-gaming. So the video stays on the phone
implementation, which is officially documented and verifiable — it does **not** claim laptops do
the same thing.

Facts (checked): normal path is wall → battery → chip, always, even plugged in (how-to-geek) ·
charging while gaming forces the battery to charge and discharge at once — two of lithium's main
stressors, cycles and heat, at the same time (scienceinsights) · bypass charging reroutes the
charger straight to the system and holds the battery steady (scienceinsights) · Samsung's Pause
USB Power Delivery requires a 25W+ PPS charger and ≥20% battery (samsung.com, official) · the
feature does not charge the device faster and does not stop the battery from aging overall —
it only skips the extra stress of that one session (consumerarena.in).

## Beat sheet

| Beat | Time | On screen | Objects | VO |
|------|------|-----------|---------|----|
| HOOK | 0–3.1s | Phone, screen lit mid-game, charging cable plugged in. Cutaway bubble: battery-cell icon frozen at a fixed %, a small lock over it; CPU chip glowing hot red; a green "BYPASS" pill lit beside it | phone body, charging cable, wall-charger brick, battery-cell icon + lock, CPU chip (hot glow), BYPASS badge | "Plugged in. Maxed out. Battery: frozen. On purpose." |
| SETUP | 4.0–10.35s | Cutaway diagram: wall charger → battery cell → chip, one arrow chain (normal path). Then the battery sprouts TWO arrows at once — one charging in, one draining out — with heat-wave squiggles rising off the cell | wall-charger brick, cable, battery-cell icon, CPU chip, directional arrows, heat-wave lines | "Normally, the wall feeds the battery, and the battery feeds the chip." / "Game while you charge, and the battery charges and drains at once." |
| REVEAL | 12.85–22.55s | A switch/relay drops into the path; the arrow reroutes bold: wall → switch → chip, skipping the battery entirely. Battery cell sits aside, static, lock icon on, heat-waves fade to nothing. Then the phone's screen shows a toggle labeled "Pause USB Power Delivery", a "25W PPS" badge, a "20%+" battery badge, and a small game-controller icon | switch/relay prop, battery-cell icon (locked, cool), CPU chip (cooled, blue glow), phone screen UI toggle, wattage badge, game-controller icon | "Bypass charging adds a switch: power goes straight to the chip, and the battery just freezes." / "Samsung calls it Pause USB Power Delivery — 25 watts, 20% battery, and charging stops." |
| TWIST | 24.35–32.5s | Two honest caveat chips land beside the phone: a crossed-out lightning bolt ("not faster charging") and a small hourglass ("battery still ages"). Then a calm checkmark settles over the battery cell — no heat, no cycle this round | lightning-bolt icon (crossed out), hourglass icon, battery-cell icon, checkmark, cooled CPU chip | "It won't make anything charge faster, and it won't stop the battery from aging." / "But this charge, this session, skips the cycle — and the heat that comes with it." |
| LOOP | 33.7–38s | Dissolve back to the hook framing: phone, cable, frozen battery %, stable-hot chip, BYPASS pill lit — rhymes with frame 0 | phone body, charging cable, battery-cell icon, CPU chip, BYPASS badge | "That's bypass charging." (payoff, no CTA) |

## Production notes

- One persistent canvas: a phone-and-cutaway diagram that never cuts away — the switch literally
  drops into the SAME power path drawn in setup, so REVEAL reads as "one component changed," not
  a new scene. Mirrors short-8's persistent-browser and short-13's persistent-bar approach.
- The heat-wave squiggles are the emotional throughline: they appear in SETUP (double stress),
  vanish the instant the switch lands in REVEAL, stay gone through TWIST — a visual argument, not
  just an asserted one.
- TWIST's two caveat chips exist so the video doesn't overclaim (brand voice: direct, no hype) —
  bypass charging is real but modest: it skips stress on THIS session, not aging in general.
- Ending is the payoff line + seamless loop (dissolve to the frozen-battery hook state). No
  engagement CTA.
