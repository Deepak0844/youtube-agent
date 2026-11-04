-- Phase 5 slice 5a: one analytics snapshot per video per day (America/Los_Angeles day, the same day YouTube quota uses).
-- Raw numbers as YouTube reported them; `retention` is the audience-retention curve [[elapsedVideoTimeRatio, audienceWatchRatio], ...].
-- `error` is set when a part of the pull failed (the numbers that did arrive are kept). A failed row may be replaced by the owner's
-- next "Run now"; a row without an error is never overwritten that day.
create table if not exists video_analytics (
  id bigserial primary key,
  video_id uuid not null references videos (id) on delete cascade,
  youtube_id text not null,
  day date not null,
  views bigint,
  likes bigint,
  comments bigint,
  analytics_views bigint,
  minutes_watched numeric,
  avg_view_pct numeric,
  retention jsonb,
  error text,
  pulled_at timestamptz not null default now(),
  unique (video_id, day)
);
create index if not exists video_analytics_video_idx on video_analytics (video_id, day desc);
