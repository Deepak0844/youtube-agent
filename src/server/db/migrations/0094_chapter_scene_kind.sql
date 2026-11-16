-- Long videos (L3): each finished chapter of a long code-scene video is saved at once as content kind `chapter_scene` (its source and the fingerprint it was
-- made from), so a failed or cut-off step redraws only the chapter that is missing. Widens the kind check; no rows change and no right is granted or revoked.
alter table video_content drop constraint if exists video_content_kind_check;
alter table video_content add constraint video_content_kind_check
  check (kind in ('script', 'beats', 'evidence', 'cost_plan', 'video', 'metadata', 'titles', 'narration', 'captions', 'scenes', 'tsx', 'frame_review', 'outline', 'thumbnail', 'clips', 'clip_batch', 'chapter_scene'));
