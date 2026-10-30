-- Voice server settings (registry: src/server/core/settings-registry.ts). Reseeding never overwrites an edit.
insert into settings (key, value, updated_by) values
  ('voice.azure_region', '""', 'system'),
  ('voice.local_url', '""', 'system'),
  ('voice.voicestudio_url', '""', 'system')
on conflict (key) do nothing;
