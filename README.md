# YT Studio

A single-owner studio that makes faceless YouTube Shorts: topic in, finished video out, with a human gate before anything is built or published. It runs on your own machine: Next.js 16 (web app), a Postgres/Redis-backed worker, and a locked-down Docker container that renders the video with Remotion.

**Status:** Phases 0 to 4 are built (foundations, engine, providers/voice/assets, scene kit, authoring, rendering, core UI). Publishing to YouTube (Phase 5) is not built yet. Real pictures for scenes (free stock and Wikimedia only; no paid AI images) are in progress.

## What a video goes through

1. **Draft:** a model researches the topic (web search through SearXNG) and writes the script, beats and evidence, with a short "what the viewer must see" line per beat. **You approve the script** at the first gate.
2. **Build:** a model turns each beat into one scene from the portrait kit (18 scene kinds: terminal, chat, chart, math, chess, piano, map, orbit and more), checked by house rules.
3. **TTS, voice, sfx:** the narration (VoiceStudio, ElevenLabs, Edge and others, in English, Hindi, Tamil, Telugu, Kannada and Malayalam), word timings, mixing and sound.
4. **Render:** Remotion renders the 1080x1920 video inside a sandbox container (no network, read-only, all capabilities dropped).
5. **Check:** ffmpeg QA (picture, audio levels, black and frozen frames, length). **You approve the video** at the second gate.

Money is never spent twice: a paid call that may have been charged and nobody can tell is parked as a decision for you. Free-tier model limits are paced automatically.

## Requirements

- Node 22, npm, Docker (OrbStack on macOS), ffmpeg and ffprobe on `PATH`.
- Postgres 17 and Redis 7 (containers are fine), and SearXNG for the Draft web search (`infra/searxng`).
- A voice server for narration, for example VoiceStudio on `127.0.0.1` (no key needed on the same machine) or an ElevenLabs key.
- A model key: the Gemini free tier works for text. Anthropic Pro users can instead route text stages to the local Claude Code program (Settings, Models, AI source; log in with a claude.ai subscription, not an API key).

## Quick start

```bash
npm install
cp .env.example .env.local          # then fill in the values; never commit .env.local
npm run vault:init                  # creates the vault master key (back it up)
npm run db:bootstrap                # once per database, see "Database roles" below
npm run db:migrate
npm run owner:create                # prints a one-time setup link for the owner account
npm run image:render                # builds the render container once
npm run dev:all                     # web app (http://127.0.0.1:3000) and worker together
```

Start Redis and SearXNG before `dev:all`, and your voice server before the first narration. `npm run check:phase4 -- --preflight` prints what is missing.

### First-time setup in the browser

1. **Settings, Keys:** save the model key (and any voice or stock keys).
2. **Settings, Models:** add a model with its price card (Structured output and Tool use ticked for Draft), then route **draft** and **build_scene_kit** to it.
3. **Settings, Providers:** set the voice server address (for example `http://127.0.0.1:3900`; on the same machine no key is needed) and pick the default narration voice under "Who is used for what".
4. **Settings, System, Local services:** list local voice or model servers as `host:port`. The app's own services (SearXNG, Redis, Postgres) must never be listed.
5. **New** (`/videos/new`): topic, language, scene kit. Approve the script when it waits at the gate.

### Limits worth knowing

- The Gemini free tier allows only a few requests a minute; calls to one model are spaced by `llm.call_gap_ms` (default 6 s).
- A finished render, voice, sfx or check step can be re-run from the video page ("Re-run this step"). Draft, Build and TTS cannot be forced, because they may cost money.
- Video files and uploads live under `.data/` (git-ignored).

### Engine commands

After migrating the local database and configuring `.env.local`:

| Command | Purpose |
|---|---|
| `npm run dev:all` | Run the Next app and background worker together. |
| `npm run worker` | Run only the Postgres/Redis-backed worker. |
| `ENGINE_DRY_RUN=1 npm run dry-run -- "a topic"` | Run one fake-provider video until its next owner gate; no network, real key or real spend. Add `--auto-approve` only on a throwaway database. |
| `npm run eval:llm -- --model <catalog-id> --mode agent --topics 10 --max-usd 2` | Print the hosted-model evaluation plan and cost ceiling without spending. Add `--yes` only after approving the capped real spend. |
| `npm run smoke:providers -- --providers elevenlabs,pixabay --cap 0.50 --lang en,hi,ta` | Owner-run live check of the voice, sound and stock providers on a local database. Prints every quote and asks y/N; `--dry-plan` calls nothing, `--yes-spend` is needed without a terminal, hard cap 2 USD. Saves raw responses (keys stripped) under `.data/smoke/`. |
| `npm run eval:scenes -- --model <model-uuid> [--per-kind 1] [--kinds a,b] [--max-usd 0.25]` | Owner-run reliability test: asks a model for scene JSON for fixed beat sheets and reports how many are valid (dry plan without `--yes`). |
| `npm run check:phase3` | Owner-run listening sheet: prints the produced audio files, captions with their flags and the mix to check by ear, from the local database and storage. No network, no paid call. |
| `npm run check:phase4` | Owner-run Phase 4 exit helper: `-- --preflight` (default) readiness checklist, `-- --plan [--lang hi]` what a real run would do and cost, `-- --check <videoId>` read-only report on a finished run. Local checks only, no spend, starts no video. |

### Portrait kit (needs `npm run image:render` once, Docker/OrbStack running)

- `npm run kit:studio` opens Remotion Studio for `remotion/kit` at http://127.0.0.1:3100 (loopback only, kit mounted read-only, no secrets).
- `npm run kit:sheet` renders frame 60 of every kit piece (same locked-down container as kit:studio) and tiles them into one grid (row-major; order printed in the terminal and captioned in `index.html`) at `.data/kit-sheet/contact-sheet.png`.
- `npm run kit:video -- scenes.json [--audio file.wav] [--captions captions.json]` validates a scene file and renders one short MP4 to `.data/kit-video/out.mp4` in the same container.
- `npm run kit:preview -- scene.json` checks a scene file, then saves frame 0 / middle / last stills to `.data/kit-preview/`. Image ids show as coloured placeholders.

## Environment variables for authentication

The app binds to 127.0.0.1 (`npm run dev` / `npm start`); a reverse proxy is required before it is public.

| Variable | Default | Meaning |
|---|---|---|
| `DATABASE_URL` | none (required) | Postgres connection string as the least-privilege role `ytstudio_app`; the web app refuses to start work without it. It cannot change the schema and cannot update or delete `audit_log`. |
| `MIGRATE_DATABASE_URL` | none | Same database as the owner role `ytstudio_owner`. Used only by `npm run db:migrate`, `owner:create`, `owner:reset` and `auth:purge` (audit retention). Never give it to the web app or worker. |
| `APP_URL` | `http://localhost:3000` | Base URL printed in the one-time setup link by `npm run owner:create` / `owner:reset`. |
| `ALLOWED_HOSTS` | `localhost,127.0.0.1,[::1]` | Comma-separated Host names the app answers to (port and trailing dot ignored, exact match). Anything else gets 400. Setting it replaces the default list. |
| `TRUST_PROXY` | unset | Set to `1` only when a reverse proxy you run sits in front. Then the client address is the RIGHTMOST `x-forwarded-for` entry (the one your proxy appended; the leftmost values are supplied by the client and are never used) and `x-forwarded-proto` decides the `Secure` cookie flag. |
| `AUTH_MAX_IN_FLIGHT` | `3` | Most login attempts handled at once, process-wide; more get 503 with `Retry-After`. `AUTH_MAX_PER_IP` (default `1`) caps one address. |

With `TRUST_PROXY` unset, Next.js gives the app no trustworthy client address, so all clients share one lockout bucket. That is fine on localhost. Before the server is public (Phase 10) it needs a reverse proxy with `TRUST_PROXY=1`, rate limiting at the proxy, and a reserved admission slot for known-good addresses so a flood cannot lock the owner out.


### Database roles (run once per database)

1. Start Postgres (OrbStack/compose) and create an empty database; keep a superuser URL for it.
2. `BOOTSTRAP_DATABASE_URL=<superuser url> YTSTUDIO_OWNER_PASSWORD=... YTSTUDIO_APP_PASSWORD=... npm run db:bootstrap`.
3. `MIGRATE_DATABASE_URL=<ytstudio_owner url> npm run db:migrate`, then run the app with `DATABASE_URL=<ytstudio_app url>`.

What the bootstrap changes (idempotent, but each run does ALL of this again): it creates/updates both roles and **rotates both passwords**, makes `ytstudio_owner` the owner of the database and of schema `public`, and **revokes all PUBLIC rights** on the database and the schema. It aborts, naming them, if schema `public` already holds tables, sequences or views owned by any other role (re-own them to `ytstudio_owner` or recreate the database), because migration 0004's default grants would otherwise silently not apply.

Password handling: the passwords are sent as parameters and the bootstrap transaction turns off statement and parameter logging, so a failure should not put them in the server log. Limits: a server with `pg_stat_statements`, `auto_explain` or a log-shipping proxy in front can still capture the `CREATE ROLE ... PASSWORD` statement; rotate the passwords afterwards if you cannot rule that out.

New tables created by later migrations get full SELECT/INSERT/UPDATE/DELETE for the app role automatically. Any ledger-like table (audit, history, money) needs an explicit `revoke update, delete, truncate ... from ytstudio_app` in its migration; `audit_log` and `schema_migrations` already have it. `spend_intents` and `upload_log` have full DML on purpose.

### Scheduled retention (owner side)

The app role cannot delete `audit_log`, so the 90-day audit retention is a **scheduled owner-side job**: `npm run auth:purge` (deletes dead sessions, login attempts older than 30 days and audit rows older than 90 days). It needs only `MIGRATE_DATABASE_URL`. Run it daily: either load `infra/com.ytstudio.auth-purge.plist` with launchd (03:15 daily), or cron, e.g. `15 3 * * * cd /path/to/youtube-agent && MIGRATE_DATABASE_URL=... npm run auth:purge`. The web app also purges sessions and attempts (not audit) at most hourly after a successful login, using only its own app role.
