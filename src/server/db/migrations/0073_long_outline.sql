-- Phase 6b slice 2: long videos get an outline stage. The outline is saved as content kind `outline` (widens the kind check; no data
-- changes), and a long video remembers the length range the owner chose in the New form (two nullable whole minutes; shorts leave them
-- empty). The range must be set together, 3 to 240 minutes, min not above max; the app also checks it against video.max_long_minutes.
alter table video_content drop constraint if exists video_content_kind_check;
alter table video_content add constraint video_content_kind_check
  check (kind in ('script', 'beats', 'evidence', 'cost_plan', 'video', 'metadata', 'titles', 'narration', 'captions', 'scenes', 'tsx', 'frame_review', 'previews', 'review', 'outline'));
alter table videos add column if not exists length_min_minutes integer;
alter table videos add column if not exists length_max_minutes integer;
alter table videos drop constraint if exists videos_length_range_check;
alter table videos add constraint videos_length_range_check
  check ((length_min_minutes is null and length_max_minutes is null)
      or (length_min_minutes is not null and length_max_minutes is not null and length_min_minutes >= 3 and length_max_minutes <= 240 and length_min_minutes <= length_max_minutes));
