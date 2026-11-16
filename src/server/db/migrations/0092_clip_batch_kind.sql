-- Clip Factory (CF4a): a batch of clips cut from a finished video is recorded as content kind `clip_batch` on the SOURCE video
-- (one version per run; old batches stay). Widens the kind check; no rows change and no right is granted or revoked.
alter table video_content drop constraint if exists video_content_kind_check;
alter table video_content add constraint video_content_kind_check
  check (kind in ('script', 'beats', 'evidence', 'cost_plan', 'video', 'metadata', 'titles', 'narration', 'captions', 'scenes', 'tsx', 'frame_review', 'outline', 'thumbnail', 'clips', 'clip_batch'));
