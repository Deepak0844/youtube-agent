-- Engine usage per video (owner request 2026-11-14): besides tokens and turns, keep which Claude model ran, the cache token
-- counts, how long the run took, and how many times each tool was used. All nullable: older runs, and runs where Claude Code
-- reported nothing, simply have no figure. The app role keeps its default grants.
alter table engine_runs
  add column if not exists model text check (model is null or length(model) <= 80),
  add column if not exists cache_read_tokens bigint check (cache_read_tokens is null or cache_read_tokens >= 0),
  add column if not exists cache_creation_tokens bigint check (cache_creation_tokens is null or cache_creation_tokens >= 0),
  add column if not exists duration_ms integer check (duration_ms is null or duration_ms >= 0),
  add column if not exists duration_api_ms integer check (duration_api_ms is null or duration_api_ms >= 0),
  add column if not exists tool_calls jsonb not null default '{}'::jsonb check (jsonb_typeof(tool_calls) = 'object');
