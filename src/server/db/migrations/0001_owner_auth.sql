-- Spike B: single-owner auth. Only SHA-256 hashes of tokens/codes are stored, never the secrets.

-- Exactly one owner, enforced by the database: id is pinned to 1 by the check, and the primary key makes a second row a conflict.
create table owner (
  id integer primary key default 1 check (id = 1),
  username text not null,
  password_hash text not null,
  -- Raw secret for now (Phase 1 vault encrypts it). Never log it.
  totp_secret text,
  -- Last accepted TOTP time step; replay protection.
  totp_last_step bigint,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table sessions (
  id uuid primary key,
  token_hash text not null unique, -- unique constraint's index serves the per-request lookup by token_hash
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  expires_at timestamptz not null,
  absolute_expires_at timestamptz not null,
  user_agent text,
  ip text,
  revoked_at timestamptz
);

create table setup_links (
  id uuid primary key,
  token_hash text not null unique, -- unique index serves lookup by token_hash
  purpose text not null check (purpose in ('create','reset')),
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);

create table recovery_codes (
  id uuid primary key,
  code_hash text not null unique, -- unique index serves lookup by code_hash
  used_at timestamptz,
  created_at timestamptz not null default now()
);

create table login_attempts (
  id bigserial primary key,
  username_key text not null,
  ip text not null,
  at timestamptz not null default now(),
  success boolean not null
);
-- Lockout counts: recent failures per username, and per client address.
create index login_attempts_username_at_idx on login_attempts (username_key, at);
create index login_attempts_ip_at_idx on login_attempts (ip, at);

create table audit_log (
  id bigserial primary key,
  at timestamptz not null default now(),
  event text not null,
  detail jsonb
);
