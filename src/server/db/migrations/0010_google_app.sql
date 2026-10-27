-- The owner's own Google Cloud app (OAuth client). The client id is not secret and lives here; the client secret lives
-- ONLY in the vault (table secrets) under client_secret_name. `legacy` rows are the Phase 9 import, read-only in the UI.
-- The app role gets select/insert/update/delete through the default privileges set in 0004.
create table if not exists google_apps (
  id                 uuid primary key default gen_random_uuid(),
  kind               text not null check (kind in ('own', 'legacy')),
  client_id          text not null check (char_length(client_id) between 1 and 200),
  client_secret_name text not null check (client_secret_name ~ '^[a-z0-9][a-z0-9._-]{0,127}$'),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

-- Phase 1: exactly one own app.
create unique index if not exists google_apps_one_own on google_apps (kind) where kind = 'own';
