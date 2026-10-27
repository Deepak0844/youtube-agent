-- Task 22: bounded retries as NEW stage rows, and a one-probe half-open breaker.
-- retry_of points at the failed row this one replaces (the failed row stays failed; its call keys are never reused).
-- not_before is a DATABASE-clock time: neither the claim nor the reconciler may start the row earlier.
alter table stage_runs
  add column retry_of uuid references stage_runs (id),
  add column not_before timestamptz;
-- A failed row can be replaced at most once, even if two sweeps race.
create unique index stage_runs_retry_of_unique on stage_runs (retry_of) where retry_of is not null;

-- When a breaker is half open exactly one stage may pass; this records when that probe was let through.
alter table breakers add column probe_at timestamptz;
