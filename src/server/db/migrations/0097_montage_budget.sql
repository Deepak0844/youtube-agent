-- Montage videos need their own per-video spend cap template (`video:montage`, the same $5 as a code-scene video). Without it a montage's
-- first paid step (narration) failed with "budget caps are not set up". Inserts one template row; nothing else changes and an existing row is kept.
insert into budgets (scope, cap_micro_usd) values ('video:montage', 5000000) on conflict (scope) do nothing;
