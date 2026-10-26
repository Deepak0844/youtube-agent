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
2. `BOOTSTRAP_DATABASE_URL=<superuser url> YTSTUDIO_OWNER_PASSWORD=... YTSTUDIO_APP_PASSWORD=... npm run db:bootstrap` (idempotent; re-running rotates both passwords).
3. `MIGRATE_DATABASE_URL=<ytstudio_owner url> npm run db:migrate`, then run the app with `DATABASE_URL=<ytstudio_app url>`.

A database created before this change, with tables owned by another user, must be re-owned to `ytstudio_owner` first (or recreated).
