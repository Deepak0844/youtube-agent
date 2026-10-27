-- Phase 2 Task 14: hosted-model Test button and the eval budget.
-- last_test: the last result of the Test button (written by src/server/db/llm-test.ts; holds only numbers and a fixed
--   sentence, never a provider body or key). Its "at" is also the cooldown clock.
-- draft_mode: how Draft uses this model. Task 18 (eval harness) is the only writer after the owner; default is the safe mode.
alter table llm_models add column if not exists last_test jsonb;
alter table llm_models add column if not exists draft_mode text not null default 'search_then_write';
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'llm_models_draft_mode_check') then
    alter table llm_models add constraint llm_models_draft_mode_check check (draft_mode in ('search_then_write', 'agent'));
  end if;
end $$;

-- Budget seeds, micro-USD (integer). "llm_test" is the DAILY cap for the Test button: the app copies it into one row per
-- UTC day ("llm_test:YYYY-MM-DD") on first use, so each day starts at zero spent. "eval" is the cap of one eval run (Task 18).
-- Fixed here on purpose; a Budgets screen comes in Phase 3. Changing them is a deliberate SQL edit by the owner.
insert into budgets (scope, cap_micro_usd) values
  ('llm_test', 500000),
  ('eval', 2000000)
on conflict (scope) do nothing;
