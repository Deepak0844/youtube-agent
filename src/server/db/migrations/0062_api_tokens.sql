-- Phase 7: API tokens for /api/v1. Only a SHA-256 hash of the secret is stored; the secret is shown once at creation and is
-- never recoverable. `prefix` (first 12 characters of the token, not secret on its own) is for display and for finding the row.
-- Scopes are deliberately tiny: read, create_draft. No scope can approve a gate, change a safety setting, or reach settings.
-- Usage is counted per IST day so a token cannot create more than its daily draft cap. The app role gets DML through 0004.
create table if not exists api_tokens (
  id               uuid primary key default gen_random_uuid(),
  name             text not null check (char_length(name) between 1 and 60),
  prefix           text not null check (prefix ~ '^yts_[A-Za-z0-9_-]{8}$'),
  token_hash       bytea not null unique check (octet_length(token_hash) = 32),
  scopes           text[] not null check (cardinality(scopes) between 1 and 2 and scopes <@ array['read', 'create_draft']::text[]),
  daily_draft_cap  integer not null default 5 check (daily_draft_cap between 0 and 100),
  created_at       timestamptz not null default now(),
  last_used_at     timestamptz,
  revoked_at       timestamptz
);
create index if not exists api_tokens_prefix on api_tokens (prefix);

create table if not exists api_token_usage (
  token_id  uuid not null references api_tokens (id) on delete cascade,
  day       date not null,
  drafts    integer not null check (drafts >= 0),
  primary key (token_id, day)
);
