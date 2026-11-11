-- Phase 8.6: a locked character. An AI video may name one library picture whose look every clip starts from, so the character is never
-- re-drawn from words. One row per video; the picture stays in the library (a purged picture leaves the video with no character, and the shot plan then refuses to guess).
create table if not exists video_characters (
  video_id uuid primary key references videos (id) on delete cascade,
  asset_id uuid references assets (id) on delete set null,
  created_at timestamptz not null default now()
);
