-- AI source switch for text stages (ADR 0014, step 2). Settings registry: src/server/core/settings-registry.ts.
-- ai.previous_routes: the routes the switch replaced (stage -> model id or null); null = the switch is off. Reseeding never overwrites an edit.
insert into settings (key, value, updated_by) values
  ('ai.previous_routes', 'null', 'system')
on conflict (key) do nothing;

-- Read-only suggestion the switch copies when the owner has no Claude Code model yet. Text only, tools off, free.
insert into model_catalog_defaults (id, provider, model_id, label, base_url, is_free, capabilities, note) values
  ('claude-code', 'claude_code', 'default', 'Claude Code (this machine)', null, true,
   '{"structuredOutput":true,"toolUse":false,"vision":false,"nativeWebSearch":false,"contextWindow":200000}',
   'Free: your Claude subscription through the claude program on this Mac. Log in with claude.ai, not a Console API key (a key would bill the API while the books say $0). Text stages only, tools off.')
on conflict (id) do nothing;

-- Claude Code runs with tools off: a row saved in step 1 may not claim tool use, image input or web search.
update llm_models set capabilities = capabilities || '{"toolUse":false,"vision":false,"nativeWebSearch":false}'
 where provider = 'claude_code';

-- The day counter only ever goes up: the app role cannot lower today's count or move a row to another day to dodge the cap.
create function claude_code_daily_calls_no_decrease() returns trigger
language plpgsql set search_path = pg_catalog, public as $$
begin
  if new.day <> old.day or new.calls < old.calls then
    raise exception 'claude_code_daily_calls only counts up' using errcode = 'check_violation';
  end if;
  return new;
end $$;
revoke all on function claude_code_daily_calls_no_decrease() from public;
create trigger claude_code_daily_calls_no_decrease before update on claude_code_daily_calls
  for each row execute function claude_code_daily_calls_no_decrease();

-- One row: the outcome class of the last finished Claude Code call (shown on the Models page; never text) and the
-- Test connection button's rate-limit clock.
create table if not exists claude_code_status (
  id boolean primary key default true check (id),
  result text check (result in ('ready', 'not_found', 'not_logged_in', 'limit_reached', 'failed')),
  result_at timestamptz,
  auth text check (auth ~ '^[A-Za-z_]{1,24}$'),
  test_at timestamptz
);
insert into claude_code_status (id) values (true) on conflict (id) do nothing;
revoke insert, delete, truncate on claude_code_status from ytstudio_app;
