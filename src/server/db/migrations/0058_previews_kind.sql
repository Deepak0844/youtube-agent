-- Phase 5d slice D2: the preview pictures of a 3D story are saved as content kind `previews` (a body with the picture list, times,
-- shot captions and the optional picture check, plus the PNG files under stills/ in the video folder). Only widens the kind check;
-- no data changes.
alter table video_content drop constraint if exists video_content_kind_check;
alter table video_content add constraint video_content_kind_check
  check (kind in ('script', 'beats', 'evidence', 'cost_plan', 'video', 'metadata', 'titles', 'narration', 'captions', 'scenes', 'tsx', 'frame_review', 'previews'));
