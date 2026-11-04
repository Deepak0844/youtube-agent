-- Phase 5d: native 3D render settings (registry: src/server/core/settings-registry.ts). Defaults equal the registry. Reseeding never overwrites an edit.
insert into settings (key, value, updated_by) values
  ('render.native_3d', 'false', 'system'),
  ('render.native_timeout_s', '1800', 'system')
on conflict (key) do nothing;
