-- engine-core (ADR 0015): one row per Claude Code run of the new video engine. Records Claude's own usage figures (tokens,
-- turns, the API-equivalent cost it reports: nothing is billed, the run uses the owner's subscription) and, when the usage
-- limit stopped a run, when it may resume. At most one running run per video. Rows go with their video. The app role gets the
-- default grants; no right is revoked or granted beyond that.
create table if not exists engine_runs (
  id uuid primary key default gen_random_uuid(),
  video_id uuid not null references videos (id) on delete cascade,
  stage_run_id uuid not null,
  kind text not null check (kind in ('research', 'build')),
  status text not null default 'running' check (status in ('running', 'succeeded', 'failed', 'killed', 'limit')),
  started_at timestamptz not null default clock_timestamp(),
  ended_at timestamptz,
  input_tokens bigint check (input_tokens is null or input_tokens >= 0),
  output_tokens bigint check (output_tokens is null or output_tokens >= 0),
  cost_usd_equiv numeric(12, 6) check (cost_usd_equiv is null or cost_usd_equiv >= 0),
  turns integer check (turns is null or turns >= 0),
  resume_at timestamptz,
  resumed_at timestamptz,
  error text check (error is null or length(error) <= 500),
  check ((status = 'limit') = (resume_at is not null)),
  check ((status = 'running') = (ended_at is null))
);

create unique index if not exists engine_runs_one_running_per_video on engine_runs (video_id) where status = 'running';
create index if not exists engine_runs_due_limit on engine_runs (resume_at) where status = 'limit' and resumed_at is null;
create index if not exists engine_runs_ended_at on engine_runs (ended_at);
