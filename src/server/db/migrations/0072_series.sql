-- Phase 6b piece 6b.1: series. A series groups planned parts that each become a normal video when the owner starts them.
-- Text is untrusted (typed or pasted), so the database limits lengths too. A series never approves or uploads anything.
create table if not exists series (
  id uuid primary key default gen_random_uuid(),
  title text not null check (char_length(title) between 3 and 80),
  premise text not null default '' check (char_length(premise) <= 1000),
  channel_id text references youtube_channels (channel_id) on delete set null,
  language text not null default 'en' check (language in ('en', 'hi', 'ta', 'te', 'ml', 'kn')),
  formats text not null default 'short' check (formats in ('short', 'long', 'mixed')),
  settings jsonb not null default '{}'::jsonb check (jsonb_typeof(settings) = 'object'),
  -- null = no limit
  cap_micro_usd bigint check (cap_micro_usd is null or cap_micro_usd >= 0),
  parts_planned integer not null default 0 check (parts_planned between 0 and 50),
  playlist_id text,
  status text not null default 'active' check (status in ('active', 'done', 'archived')),
  created_at timestamptz not null default now()
);

create table if not exists series_parts (
  series_id uuid not null references series (id) on delete cascade,
  part_no integer not null check (part_no >= 1),
  title text not null check (char_length(title) between 1 and 200),
  one_line text not null default '' check (char_length(one_line) <= 400),
  format text not null default 'short' check (format in ('short', 'long')),
  status text not null default 'planned' check (status in ('planned', 'started', 'dropped')),
  video_id uuid unique references videos (id) on delete set null,
  primary key (series_id, part_no)
);

alter table videos add column if not exists series_id uuid references series (id) on delete set null;
alter table videos add column if not exists part_no integer check (part_no is null or part_no >= 1);
alter table videos add column if not exists derived_from uuid references videos (id) on delete set null;
create index if not exists videos_series_idx on videos (series_id, part_no);
