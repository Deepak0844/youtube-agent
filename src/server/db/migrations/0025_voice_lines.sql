-- Phase 3 Task 04: per-line voice cache. One row per synthesised line; the key is the hash of text, voice, model, language and settings,
-- so rewriting one line re-bills only that line. The row is written after its audio file exists.
create table if not exists voice_lines (
  cache_key text primary key,
  provider text not null,
  bytes bigint not null check (bytes >= 0),
  sha256 text not null,
  duration_s numeric not null check (duration_s >= 0),
  word_timings jsonb,
  timings_kind text not null check (timings_kind in ('native', 'aligned', 'estimated', 'none')),
  file_path text not null,
  price_micro_usd bigint not null check (price_micro_usd >= 0),
  created_at timestamptz not null default now(),
  last_used_at timestamptz not null default now()
);

-- A cached row is what we bill and play from: once written, only last_used_at may change.
revoke update, truncate on voice_lines from ytstudio_app;
grant update (last_used_at) on voice_lines to ytstudio_app;
