-- engine-core (ADR 0015): the new video engine's settings (registry: src/server/core/settings-registry.ts). Defaults equal the
-- registry; the engine starts switched off. Reseeding never overwrites an edit.
insert into settings (key, value, updated_by) values
  ('engine.enabled', 'false', 'system'),
  ('engine.build_timeout_s', '2700', 'system'),
  ('engine.long_build_timeout_s', '5400', 'system'),
  ('engine.max_turns', '80', 'system'),
  ('engine.limit_retry_s', '1800', 'system')
on conflict (key) do nothing;
