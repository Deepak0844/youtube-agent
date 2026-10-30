This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

### Engine commands

After migrating the local database and configuring `.env.local`:

| Command | Purpose |
|---|---|
| `npm run dev:all` | Run the Next app and background worker together. |
| `npm run worker` | Run only the Postgres/Redis-backed worker. |
| `ENGINE_DRY_RUN=1 npm run dry-run -- "a topic"` | Run one fake-provider video until its next owner gate; no network, real key or real spend. Add `--auto-approve` only on a throwaway database. |
| `npm run eval:llm -- --model <catalog-id> --mode agent --topics 10 --max-usd 2` | Print the hosted-model evaluation plan and cost ceiling without spending. Add `--yes` only after approving the capped real spend. |
| `npm run smoke:providers -- --providers elevenlabs,pixabay --cap 0.50 --lang en,hi,ta` | Owner-run live check of the voice, sound and stock providers on a local database. Prints every quote and asks y/N; `--dry-plan` calls nothing, `--yes-spend` is needed without a terminal, hard cap 2 USD. Saves raw responses (keys stripped) under `.data/smoke/`. |

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.

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
