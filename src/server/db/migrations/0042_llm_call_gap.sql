-- Pacing between calls to one hosted model (registry: src/server/core/settings-registry.ts). Reseeding never overwrites an edit.
insert into settings (key, value, updated_by) values
  ('llm.call_gap_ms', '4000', 'system')
on conflict (key) do nothing;
