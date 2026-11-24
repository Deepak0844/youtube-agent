-- Cartoon videos (owner 2026-11-24): the owner can send a finished scene back with a short note ("ending too plain", "bubble covers the face"). The note is kept
-- with the video, at most 3 per video (checked in the app), and is read once by the next scene build (used_at). Free text, 1 to 500 characters.
create table if not exists scene_notes (
  id uuid primary key,
  video_id uuid not null references videos(id) on delete cascade,
  note text not null check (char_length(note) between 1 and 500),
  used_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists scene_notes_video_idx on scene_notes (video_id, created_at);
