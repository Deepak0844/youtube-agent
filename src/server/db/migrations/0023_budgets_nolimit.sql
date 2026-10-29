-- Phase 3 Task 01: a budget cap may be "no limit". NULL means no limit; it is never read as zero (a cap of 0 refuses all spend).
-- One representation only: no separate flag column. The old unnamed check already passed NULL; it is replaced by a named one that says so.
alter table budgets alter column cap_micro_usd drop not null;
alter table budgets drop constraint if exists budgets_cap_micro_usd_check;
alter table budgets add constraint budgets_cap_nonneg_or_null check (cap_micro_usd is null or cap_micro_usd >= 0);
