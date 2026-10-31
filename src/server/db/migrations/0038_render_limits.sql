-- Phase 4: render sandbox limits (registry: src/server/core/settings-registry.ts). Reseeding never overwrites an edit.
insert into settings (key, value, updated_by) values
  ('render.timeout_s', '600', 'system'),
  ('render.cpus', '4', 'system'),
  ('render.memory_mb', '4096', 'system'),
  ('render.pids', '512', 'system')
on conflict (key) do nothing;
