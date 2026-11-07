-- Phase 6 piece 6.4: competitor research. Public YouTube stats about other channels, plus trend lists (Hacker News, Wikimedia).
-- Every row has refreshed_at; a job deletes rows not refreshed within 30 days (YouTube API data-retention rule, Doc 10).
-- owner_channel_id is the owner's own connected channel; disconnecting it removes its research rows.
create table if not exists research_watch (
  owner_channel_id text not null references youtube_channels (channel_id) on delete cascade,
  competitor_id    text not null check (competitor_id ~ '^[A-Za-z0-9_-]{1,64}$'),
  title            text not null default '' check (char_length(title) <= 200),
  added_by         text not null default 'owner' check (added_by in ('owner', 'owner-handle')),
  added_at         timestamptz not null default now(),
  refreshed_at     timestamptz not null default now(),
  primary key (owner_channel_id, competitor_id)
);

create table if not exists research_candidates (
  owner_channel_id text not null references youtube_channels (channel_id) on delete cascade,
  competitor_id    text not null check (competitor_id ~ '^[A-Za-z0-9_-]{1,64}$'),
  title            text not null default '' check (char_length(title) <= 200),
  score            numeric not null default 0,
  reason           text not null default '' check (char_length(reason) <= 500),
  status           text not null default 'suggested' check (status in ('suggested', 'watching', 'rejected')),
  subs             bigint not null default 0,
  found_at         timestamptz not null default now(),
  refreshed_at     timestamptz not null default now(),
  primary key (owner_channel_id, competitor_id)
);

create table if not exists research_videos (
  owner_channel_id text not null references youtube_channels (channel_id) on delete cascade,
  competitor_id    text not null check (competitor_id ~ '^[A-Za-z0-9_-]{1,64}$'),
  video_id         text not null check (video_id ~ '^[A-Za-z0-9_-]{1,64}$'),
  title            text not null default '' check (char_length(title) <= 300),
  published_at     timestamptz,
  views            bigint not null default 0,
  duration_s       integer not null default 0,
  refreshed_at     timestamptz not null default now(),
  primary key (owner_channel_id, video_id)
);
create index if not exists research_videos_comp_idx on research_videos (owner_channel_id, competitor_id);

create table if not exists research_trends (
  source       text not null check (source in ('hackernews', 'wikimedia')),
  item_key     text not null check (char_length(item_key) between 1 and 200),
  topic        text not null check (char_length(topic) <= 300),
  signal       bigint not null default 0,
  url          text not null check (url ~ '^https://'),
  refreshed_at timestamptz not null default now(),
  primary key (source, item_key)
);

-- YouTube search.list calls per UTC day (the app stops itself at 90 of the 100 a day the old app allowed).
create table if not exists research_searches (
  day date primary key,
  n   integer not null default 0 check (n >= 0)
);
