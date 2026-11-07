-- Phase 6 piece 6.5: insights. Weekly reviews, optimizer proposals and title experiments.
-- Nothing here changes anything on YouTube: a proposal or an experiment is only a record the owner reads and decides on.

-- One review per ISO week (a second "Run review now" in the same week replaces it). `data` holds the numbers (computed from
-- the database, never by a model); `notes` holds the model's observations only.
create table if not exists reviews (
  id bigserial primary key,
  week text not null unique check (week ~ '^[0-9]{4}-W[0-9]{2}$'),
  data jsonb not null,
  notes jsonb not null default '[]'::jsonb,
  cost_micro_usd bigint not null default 0 check (cost_micro_usd >= 0),
  created_at timestamptz not null default now()
);

create table if not exists proposals (
  id bigserial primary key,
  kind text not null check (kind in ('title', 'hook', 'idea', 'policy')),
  video_id uuid references videos (id) on delete set null,
  title text not null check (length(title) between 1 and 160),
  detail text not null default '' check (length(detail) <= 600),
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'open' check (status in ('open', 'accepted', 'dismissed')),
  decided_by text,
  decided_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists proposals_status_idx on proposals (status, created_at desc);

-- Sequential A/B title test for one uploaded video: title A for a window, then title B for the next. Advisory only.
create table if not exists title_experiments (
  id bigserial primary key,
  video_id uuid not null references videos (id) on delete cascade,
  title_a text not null check (length(title_a) between 5 and 95),
  title_b text not null check (length(title_b) between 5 and 95 and title_b <> title_a),
  window_days numeric not null check (window_days between 1 and 28),
  status text not null default 'planned' check (status in ('planned', 'running', 'measured', 'concluded')),
  phases jsonb not null default '[]'::jsonb,
  result jsonb,
  created_at timestamptz not null default now()
);
