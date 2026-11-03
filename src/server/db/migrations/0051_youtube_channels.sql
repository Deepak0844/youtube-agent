-- Phase 5 slice 1: connected Google accounts and YouTube channels. Refresh tokens live ONLY in the vault (table secrets);
-- these tables hold the vault entry NAME, never a token. A new channel is 'unconfirmed' until the owner presses "Yes, this is my channel".
-- Safety defaults: production=false, allow_public=false; made_for_kids is the owner's explicit choice (default false = "not for kids").
create table if not exists google_accounts (
  id         uuid primary key default gen_random_uuid(),
  google_sub text not null unique check (char_length(google_sub) between 1 and 64),
  email      text not null default '' check (char_length(email) <= 320),
  label      text not null default '' check (char_length(label) <= 100),
  created_at timestamptz not null default now()
);

create table if not exists youtube_channels (
  id                uuid primary key default gen_random_uuid(),
  google_account_id uuid not null references google_accounts (id) on delete cascade,
  channel_id        text not null unique check (channel_id ~ '^[A-Za-z0-9_-]{1,64}$'),
  title             text not null default '' check (char_length(title) <= 200),
  label             text not null default '' check (char_length(label) <= 100),
  status            text not null default 'unconfirmed' check (status in ('connected', 'needs_reconnect', 'unconfirmed')),
  production        boolean not null default false,
  allow_public      boolean not null default false,
  made_for_kids     boolean not null default false,
  token_secret_name text not null check (token_secret_name ~ '^[a-z0-9][a-z0-9._-]{0,127}$'),
  scopes            text not null default '',
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

-- Server-side OAuth state: only a hash of the random state is stored; single use (deleted when consumed), short expiry,
-- bound to the owner session. The PKCE verifier is useless without the one-time code Google sends to our own redirect.
create table if not exists oauth_states (
  state_hash text primary key check (state_hash ~ '^[0-9a-f]{64}$'),
  session_id uuid not null,
  verifier   text not null check (char_length(verifier) between 43 and 128),
  expires_at timestamptz not null
);

-- YouTube API units used per day (Google resets at midnight Pacific; `day` is that Pacific date).
create table if not exists quota_usage (
  day   date primary key,
  units integer not null default 0 check (units >= 0)
);
