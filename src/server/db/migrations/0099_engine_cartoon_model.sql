-- Cartoon styles (owner 2026-11-24): the Claude model cartoon videos use, Opus unless the owner picks Sonnet (the test videos were made with Opus).
-- Reseeding never overwrites an edit.
insert into settings (key, value, updated_by) values ('engine.cartoon_model', '"opus"', 'system')
on conflict (key) do nothing;
