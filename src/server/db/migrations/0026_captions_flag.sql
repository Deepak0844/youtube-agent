-- Phase 3 Task 09: caption timings are stored as content kind `captions`.
-- Body: { timings_kind, words, needs_check, flags, approximate }.
alter table video_content drop constraint if exists video_content_kind_check;
alter table video_content add constraint video_content_kind_check
  check (kind in ('script', 'beats', 'evidence', 'cost_plan', 'video', 'metadata', 'titles', 'narration', 'captions'));
