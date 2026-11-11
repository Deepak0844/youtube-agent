-- Phase 9: the optional extra folder every backup is also copied to (settings table, no new table). Empty = off.
insert into settings (key, value, updated_by) values ('backup.extra_dir', '""'::jsonb, 'system') on conflict (key) do nothing;
