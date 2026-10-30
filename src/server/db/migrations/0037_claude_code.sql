-- Claude Code text provider (ADR 0014). Settings registry: src/server/core/settings-registry.ts. Reseeding never overwrites an edit.
insert into settings (key, value, updated_by) values
  ('claude_code.enabled', 'false', 'system'),
  ('claude_code.daily_cap', '200', 'system')
on conflict (key) do nothing;

-- Calls started per UTC day, counted BEFORE the process starts (src/server/db/claude-code.ts).
create table if not exists claude_code_daily_calls (
  day date primary key,
  calls integer not null check (calls >= 0)
);
