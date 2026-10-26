-- Owner settings (registry: src/server/core/settings-registry.ts) and default seed. Reseeding never overwrites an edit.
-- The app role gets full DML on this table through the default privileges set in 0004.
create table if not exists settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now(),
  updated_by text
);

insert into settings (key, value, updated_by) values
  ('jobs.concurrent_renders', '1', 'system'),
  ('jobs.concurrent_jobs', '2', 'system'),
  ('storage.warn_gb', '50', 'system'),
  ('uploads.max_image_mb', '25', 'system'),
  ('uploads.max_image_mp', '50', 'system'),
  ('uploads.total_gb', '5', 'system'),
  ('video.max_long_minutes', '15', 'system'),
  ('tracks.enabled', '{"scene_kit":true,"tsx":true,"collage":true,"ai":true}', 'system'),
  ('policy.require_evidence', 'true', 'system'),
  ('policy.allow_public', 'false', 'system'),
  ('network.local_services', '[]', 'system'),
  ('display.currency', '"USD"', 'system')
on conflict (key) do nothing;

-- Default spend caps in micro-USD (Doc 02 4.5).
insert into budgets (scope, cap_micro_usd) values
  ('video:scene_kit', 2000000),
  ('video:tsx', 5000000),
  ('video:collage', 5000000),
  ('video:ai', 15000000),
  ('video:long', 8000000),
  ('day', 15000000),
  ('month', 100000000),
  ('draft_run', 3000000)
on conflict (scope) do nothing;
