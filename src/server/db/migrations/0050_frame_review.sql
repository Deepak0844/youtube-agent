-- Phase 4 frame check: after each code-scene attempt, key frames are read by a vision model. The verdict is saved as content
-- kind `frame_review` (versioned) for the video page, and the check has its own route, review_frames. Only widens a check and
-- adds a route row; no data changes.
-- The route starts ONLY on a free, enabled, image-reading model that is not Claude Code (free = marked free, or priced at zero
-- for input and output). With none, it stays unrouted and the check is skipped with a plain log line: the owner picks a paid
-- model deliberately on the Models page. The model it picked is named in the migration output (NOTICE).
alter table video_content drop constraint if exists video_content_kind_check;
alter table video_content add constraint video_content_kind_check
  check (kind in ('script', 'beats', 'evidence', 'cost_plan', 'video', 'metadata', 'titles', 'narration', 'captions', 'scenes', 'tsx', 'frame_review'));

do $$
declare
  picked record;
begin
  select id, provider, model_id into picked from llm_models
   where enabled and provider <> 'claude_code' and capabilities->>'vision' = 'true'
     and (is_free or (prices is not null
                      and coalesce(prices->>'inputPerMTokMicro', '') ~ '^0+$'
                      and coalesce(prices->>'outputPerMTokMicro', '') ~ '^0+$'))
   order by created_at, id
   limit 1;
  if found then
    insert into llm_routes (stage, model_id) values ('review_frames', picked.id) on conflict (stage) do nothing;
    raise notice 'review_frames route: % / %', picked.provider, picked.model_id;
  else
    raise notice 'review_frames route: left unset (no free vision model)';
  end if;
end
$$;
