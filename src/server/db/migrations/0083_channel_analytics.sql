-- Phase 6 leftover: subscribers gained per week, per channel. One row per channel per pull day (the same Los Angeles day the
-- video snapshots use), covering the 7 days that end 2 days before it (YouTube Analytics data lags). `error` is set when the
-- call failed; a failed row may be replaced by the next pull that day, a row without an error is never overwritten that day.
-- The app role gets the default grants.
create table if not exists channel_analytics (
  id bigserial primary key,
  channel_id text not null references youtube_channels (channel_id) on delete cascade,
  day date not null,
  start_day date not null,
  end_day date not null,
  subscribers_gained bigint,
  subscribers_lost bigint,
  error text check (error is null or length(error) <= 500),
  pulled_at timestamptz not null default now(),
  unique (channel_id, day)
);

alter table targets drop constraint if exists targets_metric_check;
alter table targets add constraint targets_metric_check check (metric in ('avg_view_pct', 'views', 'cost_per_short', 'cost_per_1k_views', 'subscribers_per_week'));
