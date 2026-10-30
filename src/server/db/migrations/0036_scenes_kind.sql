-- Phase 4: the Build stage stores the validated scene document as content kind `scenes`.
-- Body: { version, scenes: [...] } (src/shared/scene). Only widens the allowed kinds; no data changes.
alter table video_content drop constraint if exists video_content_kind_check;
alter table video_content add constraint video_content_kind_check
  check (kind in ('script', 'beats', 'evidence', 'cost_plan', 'video', 'metadata', 'titles', 'narration', 'captions', 'scenes'));
