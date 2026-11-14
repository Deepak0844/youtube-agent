-- OpenMontage parity (owner 2026-11-14): the Claude model engine runs use, Sonnet unless the owner picks Opus. Reseeding never
-- overwrites an edit.
insert into settings (key, value, updated_by) values ('engine.model', '"sonnet"', 'system')
on conflict (key) do nothing;
