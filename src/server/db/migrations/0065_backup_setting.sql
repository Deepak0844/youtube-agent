-- Phase 7: result of the last backup run (settings table, no new table). null until the first run.
insert into settings (key, value, updated_by) values ('backup.last_run', 'null'::jsonb, 'system') on conflict (key) do nothing;
