-- Montage (M3): a new video kind `montage` (a Short made of free stock footage) and a new content kind `footage` (the clips picked for a video, with
-- their licence lines). Widens two check constraints; no rows change and no right is granted or revoked.
alter table videos drop constraint if exists videos_kind_check;
alter table videos add constraint videos_kind_check check (kind in ('scene_kit', 'tsx', 'collage', 'ai', 'montage'));
alter table video_content drop constraint if exists video_content_kind_check;
alter table video_content add constraint video_content_kind_check
  check (kind in ('script', 'beats', 'evidence', 'cost_plan', 'video', 'metadata', 'titles', 'narration', 'captions', 'scenes', 'tsx', 'frame_review', 'outline', 'thumbnail', 'clips', 'clip_batch', 'chapter_scene', 'footage'));
