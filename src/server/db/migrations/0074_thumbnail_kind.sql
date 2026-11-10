-- Phase 6b slice 3: a long video gets a thumbnail (a drawn card, or the owner's own picture with the title on it). It is saved as content
-- kind `thumbnail` (widens the kind check; no data changes). The thumbnail gate already exists; its hash covers this content.
alter table video_content drop constraint if exists video_content_kind_check;
alter table video_content add constraint video_content_kind_check
  check (kind in ('script', 'beats', 'evidence', 'cost_plan', 'video', 'metadata', 'titles', 'narration', 'captions', 'scenes', 'tsx', 'frame_review', 'previews', 'review', 'outline', 'thumbnail'));
