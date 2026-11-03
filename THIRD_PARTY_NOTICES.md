# Third-party notices

What third-party material the video kit, the app and the render image ship. Read from files in the repo and from the installed `node_modules` on 2026-11-03 (no installs, no network). Anything not proven by a file is marked `UNKNOWN: needs owner check`. This is a fact sheet, not legal advice. Extends `remotion/kit/LICENSES.md`.

"Attribution" means a visible credit or a notice that must travel with the files.

| Item | Used for | Licence | Source | Attribution | Open question |
|---|---|---|---|---|---|
| Remotion (`remotion`, `@remotion/player` 4.0.538 in package.json; cli, bundler, renderer 4.0.538 in render image) | Kit scenes, in-app preview player, server-side renders | Remotion License (package.json says `SEE LICENSE IN LICENSE.md`). Free for individuals, for-profit orgs up to 3 employees, non-profits, evaluators. Others need a Company License. Header notes the terms change in Remotion 5.0. | https://github.com/remotion-dev/remotion/blob/main/LICENSE.md, https://www.remotion.pro/license | None named in LICENSE.md | OWNER TO CONFIRM: does the Free License cover a self-run automated render pipeline (LICENSE.md text does not mention automated or server-side rendering)? Is the owner an "individual" for this project (ADR 0002 records yes, 2026-10-24)? Re-check before any upgrade to 5.x or if a company starts using it. |
| `@remotion/shapes`, `@remotion/paths` 4.0.538 | Render image (imported by model-written TSX scenes, ADR 0009) and app dependencies (their typings, for the TSX type-check); the scene kit does not import them | Remotion License (same as above). Note: their npm metadata, and so `package-lock.json`, says "MIT"; we treat them as Remotion License, like the rest of the Remotion monorepo | https://github.com/remotion-dev/remotion | None | Keep: allowed imports of the TSX path (`src/server/core/tsx-check.ts`). |
| claude-faceless-shorts-creator (the `yt-kit` drawing library, `remotion/kit/tsxlib`) | Code scenes: vetted components (backdrop, title, kicker, captions, progress bar, tech props, electricity props) that model-written TSX imports as `yt-kit` | MIT, Copyright (c) 2026 Hasan Aboul Hasan (read from that repo's LICENSE). Full text under "MIT notice" below. | the owner's earlier repo: `lib/shorts.tsx`, `lib/techprops.tsx`, `lib/electric.tsx` | The copyright and permission notice must stay with copies: each ported file carries it in its header comment, and the text is below. | None. Restyled and adapted; the notice stays. |
| ffmpeg / ffprobe (host) | Sound mix, QA scan, 16:9 / 1:1 re-frame, probe (`src/server/render/*`, `src/server/core/reframe.ts`) | Depends on the build installed on the host. UNKNOWN: needs owner check (README only says "ffmpeg and ffprobe on PATH"). Re-frame uses libx264, which makes a build GPL. | https://ffmpeg.org/legal.html | None for use. Only matters if the binary is redistributed. | The repo does not ship or redistribute a host ffmpeg. Owner check: which build is installed, and that it is never baked into an image or shared. |
| ffmpeg inside the render image | Not installed by `infra/Dockerfile.render` (no apt ffmpeg). Remotion's own compositor may carry its own build. | UNKNOWN: needs owner check (the compositor package is not in `node_modules` here; not read) | https://www.remotion.dev/docs/miscellaneous/ffmpeg-licensing (not fetched) | UNKNOWN | After `npm ci` in the image, read the licence files of the `@remotion/compositor-*` package and confirm the ffmpeg build is LGPL/GPL and what that asks if the image is ever shared. |
| Chrome Headless Shell | Page renderer in the render image (`npx remotion browser ensure`) | Chromium: BSD-3-Clause plus bundled third-party licences. UNKNOWN: not verified from a file in the repo. | https://www.chromium.org/chromium-os/licensing/ | Only if the image is redistributed | UNKNOWN: needs owner check, image is not redistributed today. |
| lucide-react ^1.61.0 (app), 1.23.0 (render image) | App UI icons | ISC (read from `node_modules/lucide-react/package.json` and LICENSE: "Copyright (c) 2026 Lucide Icons and Contributors") | https://github.com/lucide-icons/lucide | Licence notice must stay with copies; npm keeps it. No visible credit. | The image copy 1.23.0 was not read; new kit does not import it. |
| chroma-js 3.2.0 | Render image only (installed from the old kit); not imported anywhere in `src`, `remotion`, `scripts` (grep) | UNKNOWN: needs owner check (not in `node_modules` here; not read) | https://github.com/gka/chroma.js | UNKNOWN | Candidate to drop from `infra/Dockerfile.render`; then the question goes away. |
| react / react-dom 19.3.0 | App and kit | MIT (react read from node_modules) | https://github.com/facebook/react | Notice stays with copies | None. |
| next 16.4.3, zod 4.6.7, sonner 2.0.8 | App | MIT (read from node_modules) | npm | Notice stays with copies | None. |
| sharp ^0.35.5 (+ `@img/sharp-libvips-*`) | Image handling | sharp: Apache-2.0 (read). libvips binaries (`@img/sharp-libvips-*`): UNKNOWN: needs owner check (LGPL expected, not read) | https://github.com/lovell/sharp | Apache notices stay with copies | Read the libvips licence file if the app is ever distributed as a package. |
| Other npm packages (radix-ui, ai SDK, bullmq, ioredis, pg, undici, ipaddr.js, clsx, tailwind-merge, tailwindcss, and so on) | App and worker | UNKNOWN: needs owner check (not individually read) | npm | Notice stays with copies | Run a licence report (for example `npx license-checker`) once; this pass did not install anything. |
| Inter (variable ttf) | Kit UI font (`remotion/kit/theme.ts`), render image | SIL OFL 1.1 (`infra/render/fonts/OFL-Inter.txt`) | https://github.com/google/fonts/tree/main/ofl/inter | OFL text must travel with the font; no visible credit. Done in `Dockerfile.render`. | None. |
| JetBrains Mono | Kit mono font | SIL OFL 1.1 (`OFL-JetBrainsMono.txt`) | https://github.com/google/fonts/tree/main/ofl/jetbrainsmono | Same as Inter | None. |
| Space Grotesk, Spectral (Medium, SemiBold), Source Serif 4 | Old-kit brand fonts, in render image | SIL OFL 1.1 (`OFL-SpaceGrotesk.txt`, `OFL-Spectral.txt`, `OFL-SourceSerif4.txt`) | https://github.com/google/fonts (see `infra/render/fonts/README.md` for each file URL) | Same as Inter | None. |
| Noto Sans Devanagari, Tamil, Telugu, Kannada, Malayalam | Indic caption fallback (`remotion/kit/fonts`, `infra/render/fonts`) | SIL OFL 1.1 (OFL-*.txt beside each file) | https://github.com/google/fonts (see `remotion/kit/fonts/FONTS.md`) | Same as Inter | None. |
| Instrument Sans (latin woff2) and Noto Sans (latin plus Indic woff2) | App UI fonts (`src/ui/fonts.ts`, `public/fonts`) | SIL OFL 1.1 (`public/fonts/licences/*.OFL.txt`; checksums in `public/fonts/SHA256SUMS.txt`) | https://github.com/Instrument/instrument-sans, https://github.com/notofonts | Licence text kept in `public/fonts/licences` | None. |
| Natural Earth 110m country outlines | Map scene (`remotion/kit/world.ts`, rounded to 0.5 degree) | Public domain (per `remotion/kit/LICENSES.md`; carried over from the old kit header) | https://www.naturalearthdata.com/about/terms-of-use/ | None | Terms page not re-fetched this pass. |
| Chess piece art | Chess scene (`remotion/kit/Chess.tsx`) | Original flat glyphs drawn for this project (code comment). The old kit's cburnett set was deliberately not copied. | none (own work) | None | Owner to confirm the glyphs were drawn fresh and not traced from another set. The comment is the only evidence. |
| SFX library, 33 clips (`assets-builtin/audio/sfx`) | Post-mix sound effects | 29 clips: `source` = `elevenlabs:sound-generation`, `license` text says generated by the repo author, commercial use per the generating account's ElevenLabs plan. 4 piano chord clips: `source` = tools/gen_chords.py synth, no `license` field (own synthesis). | https://elevenlabs.io/terms | UNKNOWN: depends on the ElevenLabs plan used | OWNER TO CONFIRM: the plan in use at generation time allowed commercial use of generated audio; whether a free plan (if used) needed a credit. Manifest has no plan name or date. |
| Music library, 6 clips (`assets-builtin/audio/music`) | Background beds | `source` = `elevenlabs:music`, model `music_v2`, same licence text as the SFX | https://elevenlabs.io/terms | UNKNOWN: same as SFX | Same as SFX. Confirm music generation is covered by the plan's commercial terms. |

## Summary of open questions for the owner

1. Remotion: is a self-run automated render pipeline within the Free License? Re-check on Remotion 5.0.
2. ffmpeg: which host build is installed (libx264 means GPL), and which ffmpeg the render image's compositor carries.
3. ElevenLabs: plan and terms behind the 35 generated SFX and music clips.
4. Chess glyphs: confirm they are original work.
5. chroma-js: drop from the render image, or read its licence. (`@remotion/shapes`, `@remotion/paths` stay: the TSX path imports them.)
6. Run one npm licence report to close the "other packages" row.

## MIT notice (yt-kit, ported from claude-faceless-shorts-creator)

MIT License

Copyright (c) 2026 Hasan Aboul Hasan

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
