-- The rupee rate is fetched once a day from a free public service (owner 2026-11-14). display.inr_auto: on by default;
-- display.inr_meta: where and when the rate came from, null until the first fetch. Reseeding never overwrites an edit.
insert into settings (key, value, updated_by) values
  ('display.inr_auto', 'true', 'system'),
  ('display.inr_meta', 'null', 'system')
on conflict (key) do nothing;
