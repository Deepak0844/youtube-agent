-- Phase 6 piece 6.2: targets (what "working" means) and the pause-drafting rule's settings.
-- channel_id is a YouTube channel id, or null for "all channels". value is dollars for the cost metrics, a percent or a count otherwise.
create table if not exists targets (
  id bigserial primary key,
  channel_id text check (channel_id is null or channel_id ~ '^[A-Za-z0-9_-]{1,64}$'),
  metric text not null check (metric in ('avg_view_pct', 'views', 'cost_per_short', 'cost_per_1k_views')),
  op text not null check (op in ('>=', '<=')),
  value numeric not null check (value >= 0 and value <= 1000000000),
  created_at timestamptz not null default now()
);
create unique index if not exists targets_channel_metric_uq on targets (coalesce(channel_id, ''), metric);

-- pause_n: pause drafting when cost per 1,000 views is over target for each of the last N shorts (0 = rule off).
-- pause_fired: when the rule last paused drafting (null = not yet; saving the rule clears it so it can fire once more).
insert into settings (key, value, updated_by) values
  ('targets.pause_n', '0'::jsonb, 'system'),
  ('targets.rpm_usd', '0'::jsonb, 'system'),
  ('targets.pause_fired', 'null'::jsonb, 'system')
on conflict (key) do nothing;
