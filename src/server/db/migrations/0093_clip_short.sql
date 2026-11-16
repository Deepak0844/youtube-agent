-- Clip Factory (CF4b-2): a Short made from a clip of a finished video. `clip_of` names the source video (null once it is deleted),
-- `clip_batch` and `clip_id` say which batch and clip of it, `clip_start_ms`/`clip_end_ms` where the clip sits in the source.
-- All four marker columns or none; one Short per clip (a second request makes nothing). No rights change; existing rows are untouched.
alter table videos add column if not exists clip_of uuid references videos (id) on delete set null;
alter table videos add column if not exists clip_batch integer;
alter table videos add column if not exists clip_id text;
alter table videos add column if not exists clip_start_ms integer;
alter table videos add column if not exists clip_end_ms integer;
alter table videos drop constraint if exists videos_clip_marker_check;
alter table videos add constraint videos_clip_marker_check
  check ((clip_batch is null) = (clip_id is null) and (clip_batch is null) = (clip_start_ms is null) and (clip_batch is null) = (clip_end_ms is null)
         and (clip_batch is null or (clip_batch >= 1 and clip_start_ms >= 0 and clip_end_ms > clip_start_ms)));
alter table videos drop constraint if exists videos_clip_source_check;
alter table videos add constraint videos_clip_source_check check (clip_of is null or clip_batch is not null);
create unique index if not exists videos_one_short_per_clip on videos (clip_of, clip_batch, clip_id) where clip_of is not null;
