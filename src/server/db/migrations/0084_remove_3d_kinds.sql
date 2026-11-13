-- Owner decision 2026-11-13: every 3D video kind (scale3d, scene3d, scene3d_code) is removed from the app. The 3D test videos
-- are deleted with the rows that block a delete (approvals restrict it, spend_intents and stage_runs have no cascade); every
-- other per-video table cascades or is set to null. All 3D spend was $0 (Claude Code route). A video that was ever uploaded
-- makes this migration fail instead of deleting upload history. Then the kind check narrows, and the 3D model routes, spend
-- caps and native-3D settings go. Append-only logs (events, agent_steps, notification_log) keep their rows.
do $$
begin
  if exists (select 1 from uploads u join videos v on v.id = u.video_id where v.kind in ('scale3d', 'scene3d', 'scene3d_code')) then
    raise exception 'a 3D video has an upload row; refusing to delete it';
  end if;
end $$;

create temporary table gone_videos on commit drop as
  select id from videos where kind in ('scale3d', 'scene3d', 'scene3d_code');

delete from spend_intents where stage_run_id in (select id from stage_runs where video_id in (select id from gone_videos));
update stage_runs set retry_of = null where video_id in (select id from gone_videos);
delete from stage_runs where video_id in (select id from gone_videos);
delete from approvals where video_id in (select id from gone_videos);
delete from notifications where video_id in (select id from gone_videos);
delete from videos where id in (select id from gone_videos);

alter table videos drop constraint if exists videos_kind_check;
alter table videos add constraint videos_kind_check check (kind in ('scene_kit', 'tsx', 'collage', 'ai'));

delete from llm_routes where stage in ('build_scale3d', 'direct_scene3d', 'author_scene3d');
delete from budgets where scope in ('video:scale3d', 'video:scene3d', 'video:scene3d_code');
delete from settings where key in ('render.native_3d', 'render.native_timeout_s', 'render.scene3d_mode');

-- The Look gate and the preview/review content existed only for 3D stories; no row uses them once those videos are gone.
alter table approvals drop constraint if exists approvals_gate_check;
alter table approvals add constraint approvals_gate_check
  check (gate in ('outline','script','cost','chapter','video','thumbnail','evidence','publish','comment_reply','allow_public','live_title'));
alter table video_content drop constraint if exists video_content_kind_check;
alter table video_content add constraint video_content_kind_check
  check (kind in ('script', 'beats', 'evidence', 'cost_plan', 'video', 'metadata', 'titles', 'narration', 'captions', 'scenes', 'tsx', 'frame_review', 'outline', 'thumbnail', 'clips'));
