-- Circuit breaker state per guarded stage (Doc 02 4.7) and the engine numbers seed (registry: core/settings-registry.ts).
-- Numbered 0014 as the Phase 2 plan reserves; 0012/0013 are taken by later Phase 2 tasks. The migrator applies by name, so order is not an issue.
create table if not exists breakers (
  stage text primary key,
  status text not null default 'closed' check (status in ('closed', 'open', 'half_open')),
  failures integer not null default 0 check (failures >= 0),
  opened_at timestamptz,
  updated_at timestamptz not null default clock_timestamp()
);

insert into settings (key, value, updated_by) values
  ('engine.retry_attempts', '3', 'system'),
  ('engine.retry_backoff_seconds', '[30,120,480]', 'system'),
  ('engine.timeout_stage_s', '1800', 'system'),
  ('engine.timeout_author_s', '2400', 'system'),
  ('engine.timeout_live_s', '43200', 'system'),
  ('engine.lease_s', '60', 'system'),
  ('engine.heartbeat_s', '5', 'system'),
  ('engine.log_cap_bytes', '5000000', 'system'),
  ('engine.cheap_text_run_budget_micro_usd', '50000', 'system'),
  ('breaker.threshold', '3', 'system'),
  ('breaker.cooldown_s', '900', 'system'),
  ('breaker.stages', '["draft","build","voice"]', 'system'),
  ('uploads.concurrent', '1', 'system'),
  ('qa.width', '1080', 'system'),
  ('qa.height', '1920', 'system'),
  ('qa.min_s', '15', 'system'),
  ('qa.max_s', '60', 'system'),
  ('qa.mean_db_min', '-40', 'system'),
  ('qa.peak_db_max', '-0.3', 'system'),
  ('qa.loop_diff_max', '14', 'system'),
  ('qa.duration_tolerance_s', '1.5', 'system'),
  ('qa.long_width', '1920', 'system'),
  ('qa.long_height', '1080', 'system'),
  ('qa.long_min_s', '180', 'system'),
  ('qa.long_max_s', '900', 'system')
on conflict (key) do nothing;
