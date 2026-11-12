# YT Studio

A single-owner studio that makes faceless YouTube Shorts: topic in, finished video out, with a human gate before anything is built or published. It runs on your own machine: Next.js 16 (web app), a Postgres/Redis-backed worker, and a locked-down Docker container that renders the video with Remotion.

**Status:** Phases 0 to 7 are built (foundations, engine, providers/voice/assets, scene kit, authoring, rendering, core UI, YouTube publishing, and the later feature phases), plus the UI redesign. AI video clips (Phase 8) and old-app feature parity (Phase 9) are in progress. Personal, local use only: there is no server deployment.

## Quick start

### Requirements

- Node 22, npm, Docker (OrbStack on macOS), ffmpeg and ffprobe on `PATH`.
- Postgres 17 and Redis 7 (containers are fine), and SearXNG for the Draft web search (`infra/searxng`).
- A voice server for narration, for example VoiceStudio on `127.0.0.1` (no key needed on the same machine) or an ElevenLabs key.
- A model key: the Gemini free tier works for text. Anthropic Pro users can instead route text stages to the local Claude Code program (Settings, Models, AI source; log in with a claude.ai subscription, not an API key).

### Steps

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

## Environment variables

Put them in `.env.local` (git-ignored; copy `.env.example`, which lists the same keys). Provider API keys do not go here; save them in the app under Settings, Keys. Values below are local-dev examples: replace every `CHANGE_ME`.

| Variable | Example value | Required | Meaning |
|---|---|---|---|
| `BOOTSTRAP_DATABASE_URL` | `postgres://postgres:CHANGE_ME@127.0.0.1:55432/ytstudio` | setup only | Superuser URL of the empty database. Used only by `npm run db:bootstrap`. |
| `YTSTUDIO_OWNER_PASSWORD` | `CHANGE_ME` | setup only | Password `db:bootstrap` gives the owner role `ytstudio_owner`. |
| `YTSTUDIO_APP_PASSWORD` | `CHANGE_ME` | setup only | Password `db:bootstrap` gives the app role `ytstudio_app`. |
| `MIGRATE_DATABASE_URL` | `postgres://ytstudio_owner:CHANGE_ME@127.0.0.1:55432/ytstudio` | yes | Owner role. Used only by `db:migrate`, `owner:create`, `owner:reset` and `auth:purge`. Never give it to the web app or worker. |
| `DATABASE_URL` | `postgres://ytstudio_app:CHANGE_ME@127.0.0.1:55432/ytstudio` | yes | Least-privilege app role used by the web app and worker. It cannot change the schema or update/delete `audit_log`. |
| `APP_URL` | `http://localhost:3000` (default) | no | Base URL printed in the one-time setup link by `owner:create` / `owner:reset`. |
| `VAULT_MASTER_KEY` | written by `npm run vault:init` | yes | Encrypts saved provider keys. Never type it by hand; back it up (losing it makes saved keys unrecoverable). |
| `VAULT_MASTER_KEY_PREVIOUS` | old key | rotation only | The old key while rotating; then run `npm run vault:rotate`. |
| `REDIS_URL` | `redis://127.0.0.1:6379` | yes | Redis for the job queue. |
| `SEARXNG_URL` | `http://127.0.0.1:8080` | for Draft | SearXNG address for the Draft web search. |
| `STORAGE_ROOT` | `.data` (default) | no | Folder for videos, audio and uploads. |
| `BACKUP_DB_CONTAINER` | `ytstudio-dev-pg` (default) | no | Postgres Docker container used by `backup:list` / `backup:restore`. |
| `ALLOWED_HOSTS` | `localhost,127.0.0.1,[::1]` (default) | no | Host names the app answers to (exact match, port and trailing dot ignored); others get 400. Setting it replaces the default list. |
| `TRUST_PROXY` | unset (default) | no | Set to `1` only behind a reverse proxy you run. Then the client address is the RIGHTMOST `x-forwarded-for` entry and `x-forwarded-proto` decides the `Secure` cookie flag. |
| `AUTH_MAX_IN_FLIGHT` | `3` (default) | no | Most login attempts handled at once; more get 503 with `Retry-After`. |
| `AUTH_MAX_PER_IP` | `1` (default) | no | Most login attempts at once from one address. |
| `ENGINE_DRY_RUN` | `1` | no | Fake providers: no network, no real spend (used with `npm run dry-run`). |

With `TRUST_PROXY` unset, Next.js gives the app no trustworthy client address, so all clients share one lockout bucket. That is fine on localhost. If it is ever exposed beyond localhost, it needs a reverse proxy with `TRUST_PROXY=1`, rate limiting at the proxy, and a reserved admission slot for known-good addresses so a flood cannot lock the owner out.

## AI providers supported

Keys are saved in the app (Settings, Keys) and encrypted in the vault. They are never read from `.env`.

| Area | Providers |
|---|---|
| Text models (draft, scene build) | Anthropic, OpenAI, Google Gemini, DeepSeek, OpenRouter, Groq, Mistral, xAI, Moonshot, Qwen (DashScope), Together, SiliconFlow, any OpenAI-compatible server (custom base URL). Local, no key: Ollama, LM Studio, Claude Code (`claude -p`, uses your claude.ai login) |
| Voice / narration | VoiceStudio (local), ElevenLabs, Microsoft Edge TTS, Azure Speech, Google Cloud TTS, OpenAI-compatible TTS, custom local HTTP voice server |
| Sound effects | ElevenLabs |
| Stock pictures and clips | Pexels, Pixabay (pictures and videos), Coverr, Wikimedia Commons, your own uploads |
| AI video clips (Phase 8) | Google Veo (via Vertex AI), Kling, Seedance |
| AI images (code exists, not used: free visuals only) | fal, Gemini, OpenAI |
| Web search for Draft | SearXNG (self-hosted, `infra/searxng`) |
| Publishing | YouTube Data API (OAuth) |
| Notifications | Desktop notification, webhook |

Every provider also has a fake version used by tests and `ENGINE_DRY_RUN=1`.

## What a video goes through

1. **Draft:** a model researches the topic (web search through SearXNG) and writes the script, beats and evidence, with a short "what the viewer must see" line per beat. **You approve the script** at the first gate.
2. **Build:** a model turns each beat into one scene from the portrait kit (18 scene kinds: terminal, chat, chart, math, chess, piano, map, orbit and more), checked by house rules.
3. **TTS, voice, sfx:** the narration (VoiceStudio, ElevenLabs, Edge and others, in English, Hindi, Tamil, Telugu, Kannada and Malayalam), word timings, mixing and sound.
4. **Render:** Remotion renders the 1080x1920 video inside a sandbox container (no network, read-only, all capabilities dropped).
5. **Check:** ffmpeg QA (picture, audio levels, black and frozen frames, length). **You approve the video** at the second gate.

Money is never spent twice: a paid call that may have been charged and nobody can tell is parked as a decision for you. Free-tier model limits are paced automatically.

## Limits worth knowing

- The Gemini free tier allows only a few requests a minute; calls to one model are spaced by `llm.call_gap_ms` (default 6 s).
- A finished render, voice, sfx or check step can be re-run from the video page ("Re-run this step"). Draft, Build and TTS cannot be forced, because they may cost money.
- Video files and uploads live under `.data/` (git-ignored).

## Commands

| Command | Purpose |
|---|---|
| `npm install` | Install dependencies. |
| `npm run dev:all` | Run the web app (http://127.0.0.1:3000) and worker together. Ctrl+C stops both. |
| `npm run dev` | Run only the web app in dev mode. |
| `npm run build` | Production build of the web app. |
| `npm start` | Run the production build on 127.0.0.1 (run `npm run worker` alongside it). |
| `npm run db:bootstrap` | Create the two database roles (once per database). |
| `npm run db:migrate` | Apply new database migrations (uses `MIGRATE_DATABASE_URL`). |
| `npm run owner:create` / `owner:reset` | Create the owner account / reset its sign-in; prints a one-time link. |
| `npm run vault:init` / `vault:check` / `vault:rotate` | Create, check or rotate the vault master key. |
| `npm run backup:list` / `backup:restore` | List or restore database backups. |
| `npm run auth:purge` | Delete old sessions, login attempts and audit rows (run daily). |
| `npm run image:render` | Build the sandboxed render container (once, and after render changes). |
| `npm run check` | Check that the required tools (ffmpeg, Docker, ...) are installed. |
| `npm run lint` / `npm run typecheck` | ESLint / TypeScript checks. |
| `npm test` | Unit tests (Vitest). |
| `npm run test:integration` | Integration tests (need the dev database and Redis). |
| `npm run test:e2e` / `test:api` / `test:ui` | Playwright tests (all / API only / desktop and phone UI). |
| `npm run design:check` | Automated design and layout check of the UI. |

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

## Database

### Database roles (run once per database)

1. Start Postgres (OrbStack/compose) and create an empty database; keep a superuser URL for it.
2. `BOOTSTRAP_DATABASE_URL=<superuser url> YTSTUDIO_OWNER_PASSWORD=... YTSTUDIO_APP_PASSWORD=... npm run db:bootstrap`.
3. `MIGRATE_DATABASE_URL=<ytstudio_owner url> npm run db:migrate`, then run the app with `DATABASE_URL=<ytstudio_app url>`.

What the bootstrap changes (idempotent, but each run does ALL of this again): it creates/updates both roles and **rotates both passwords**, makes `ytstudio_owner` the owner of the database and of schema `public`, and **revokes all PUBLIC rights** on the database and the schema. It aborts, naming them, if schema `public` already holds tables, sequences or views owned by any other role (re-own them to `ytstudio_owner` or recreate the database), because migration 0004's default grants would otherwise silently not apply.

Password handling: the passwords are sent as parameters and the bootstrap transaction turns off statement and parameter logging, so a failure should not put them in the server log. Limits: a server with `pg_stat_statements`, `auto_explain` or a log-shipping proxy in front can still capture the `CREATE ROLE ... PASSWORD` statement; rotate the passwords afterwards if you cannot rule that out.

New tables created by later migrations get full SELECT/INSERT/UPDATE/DELETE for the app role automatically. Any ledger-like table (audit, history, money) needs an explicit `revoke update, delete, truncate ... from ytstudio_app` in its migration; `audit_log` and `schema_migrations` already have it. `spend_intents` and `upload_log` have full DML on purpose.

### Scheduled retention (owner side)

The app role cannot delete `audit_log`, so the 90-day audit retention is a **scheduled owner-side job**: `npm run auth:purge` (deletes dead sessions, login attempts older than 30 days and audit rows older than 90 days). It needs only `MIGRATE_DATABASE_URL`. Run it daily: either load `infra/com.ytstudio.auth-purge.plist` with launchd (03:15 daily), or cron, e.g. `15 3 * * * cd /path/to/youtube-agent && MIGRATE_DATABASE_URL=... npm run auth:purge`. The web app also purges sessions and attempts (not audit) at most hourly after a successful login, using only its own app role.
