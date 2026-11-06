-- Phase 5e slice 3: the automatic look loop of an AI-written 3D story saves its result as content kind `review` (round, problems,
-- advice, history). Only widens the kind check; no data changes and no right is granted or revoked. Stage names have no check
-- constraint (scene3d_review needs no change), and the author's per-video cap (video:scene3d_code) already exists (0060).
alter table video_content drop constraint if exists video_content_kind_check;
alter table video_content add constraint video_content_kind_check
  check (kind in ('script', 'beats', 'evidence', 'cost_plan', 'video', 'metadata', 'titles', 'narration', 'captions', 'scenes', 'tsx', 'frame_review', 'previews', 'review'));
