-- Which pictures belong to which beat of which video (Plan B: free-source pictures). The app role gets the default
-- table grants (select, insert, update, delete); the code only ever inserts, selects and deletes here.
create table if not exists video_assets (
  video_id uuid not null references videos (id) on delete cascade,
  asset_id uuid not null references assets (id),
  beat_id text not null check (length(beat_id) between 1 and 64),
  role text not null default 'picture' check (role in ('picture')),
  position int not null default 0,
  credit text,
  source_url text,
  licence text,
  created_at timestamptz not null default now(),
  primary key (video_id, asset_id, beat_id)
);
create index if not exists video_assets_video_idx on video_assets (video_id, beat_id, position);
