-- Phase 6 piece 6.1: a log of scheduler runs. (job, run_key) is unique, so a job runs once per period (for example once a day) even if
-- it fails or a second worker ticks at the same moment; the owner's "Run now" buttons do not use this table.
create table if not exists schedule_runs (
  id bigserial primary key,
  job text not null check (job ~ '^[a-z_]{1,40}$'),
  run_key text not null check (length(run_key) between 1 and 40),
  status text not null default 'running' check (status in ('running', 'ok', 'failed')),
  message text,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  unique (job, run_key)
);
create index if not exists schedule_runs_started_idx on schedule_runs (started_at desc);

-- Scheduler settings (safety key, owner session only). Overnight drafting is off until the owner turns it on.
insert into settings (key, value, updated_by) values (
  'scheduler',
  '{"enabled":false,"hour":2,"max_drafts":2,"research":true,"max_pending":3,"tracks":["tsx"],"analytics":true,"weekly_review":true,"weekly_day":6,"weekly_hour":20,"optimizer":false,"optimizer_hour":22,"competitors":true}'::jsonb,
  'system'
) on conflict (key) do nothing;
