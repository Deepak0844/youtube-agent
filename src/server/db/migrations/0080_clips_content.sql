-- Phase 8: an AI video's generated clips are recorded as content kind `clips` (which asset belongs to which beat), so Build and Render go
-- stale when the clips change. Widens the kind check; no data changes.
alter table video_content drop constraint if exists video_content_kind_check;
alter table video_content add constraint video_content_kind_check
  check (kind in ('script', 'beats', 'evidence', 'cost_plan', 'video', 'metadata', 'titles', 'narration', 'captions', 'scenes', 'tsx', 'frame_review', 'previews', 'review', 'outline', 'thumbnail', 'clips'));
