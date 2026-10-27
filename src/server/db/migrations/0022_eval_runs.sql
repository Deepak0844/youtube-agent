-- Phase 2 Task 18: per-model Draft eval results. One row per run (a partial run, stopped by its cap, is a row too).
-- Append-only for the app role (no update, delete, truncate): history is never rewritten, so a better old result cannot be
-- kept by editing a newer one. No foreign key, like events: a result may outlive the model it names.
-- `note` holds a fixed sentence only (never a model answer, a provider body or a key).
create table if not exists llm_eval_runs (
  id uuid primary key,
  model_id uuid not null,
  started_at timestamptz not null default clock_timestamp(),
  finished_at timestamptz not null default clock_timestamp(),
  topics integer not null check (topics between 0 and 10),
  valid integer not null check (valid between 0 and 10),
  evidence_valid integer not null check (evidence_valid between 0 and 10),
  cost_micro_usd bigint not null check (cost_micro_usd >= 0),
  p50_latency_ms integer not null check (p50_latency_ms >= 0),
  mode_tested text not null check (mode_tested in ('search_then_write', 'agent')),
  note text not null default '' check (octet_length(note) <= 600),
  constraint llm_eval_runs_counts check (evidence_valid <= valid and valid <= topics)
);
create index if not exists llm_eval_runs_by_model on llm_eval_runs (model_id, started_at desc);
revoke update, delete, truncate on llm_eval_runs from ytstudio_app;
