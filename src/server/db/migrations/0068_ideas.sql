-- Phase 6 piece 6.3: the idea backlog. Text is untrusted (the owner types it now; the web researcher fills it later), so the
-- database also limits lengths. A drafted idea points at the normal video it created; the video is never approved or uploaded here.
create table if not exists ideas (
  id uuid primary key default gen_random_uuid(),
  topic text not null check (length(topic) between 8 and 200),
  hook text not null default '' check (length(hook) <= 300),
  why text not null default '' check (length(why) <= 400),
  sources jsonb not null default '[]'::jsonb check (jsonb_typeof(sources) = 'array' and jsonb_array_length(sources) <= 4),
  score numeric(3, 1) not null default 6 check (score between 2 and 10),
  status text not null default 'proposed' check (status in ('proposed', 'drafting', 'drafted', 'dismissed')),
  origin text not null default 'manual' check (origin in ('manual', 'research')),
  video_id uuid references videos (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists ideas_status_score_idx on ideas (status, score desc, created_at);
