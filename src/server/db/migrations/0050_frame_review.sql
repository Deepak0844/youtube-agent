-- Phase 4 frame check: after each code-scene attempt, key frames are read by a vision model. The verdict is saved as content
-- kind `frame_review` (versioned) for the video page, and the check has its own route, review_frames. Only widens a check and
-- adds a route row; no data changes. The route starts on the first enabled hosted model that can read images (Claude Code
-- never can); with none, it stays unrouted and the check is skipped with a plain log line.
alter table video_content drop constraint if exists video_content_kind_check;
alter table video_content add constraint video_content_kind_check
  check (kind in ('script', 'beats', 'evidence', 'cost_plan', 'video', 'metadata', 'titles', 'narration', 'captions', 'scenes', 'tsx', 'frame_review'));
insert into llm_routes (stage, model_id)
  select 'review_frames', id from llm_models
   where enabled and provider <> 'claude_code' and capabilities->>'vision' = 'true'
   order by created_at, id
   limit 1
  on conflict (stage) do nothing;
