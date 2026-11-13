-- Owner decision 2026-11-13: the scene_kit video kind is removed (the old app never had it). Its videos are deleted with the rows
-- that block a delete (approvals restrict it, spend_intents and stage_runs have no cascade); every other per-video table cascades or
-- is set to null. A scene-kit video that was ever uploaded makes this migration fail instead of deleting upload history. Then the kind
-- check narrows to tsx, collage and ai, the scene-kit spend cap and media routes go, and tracks.enabled loses its scene_kit flag.
-- The build_scene_kit model route stays: Collage and AI videos still use the scene Build. Append-only logs keep their rows.
do $$
begin
  if exists (select 1 from uploads u join videos v on v.id = u.video_id where v.kind = 'scene_kit') then
    raise exception 'a scene-kit video has an upload row; refusing to delete it';
  end if;
end $$;

create temporary table gone_videos on commit drop as
  select id from videos where kind = 'scene_kit';

delete from spend_intents where stage_run_id in (select id from stage_runs where video_id in (select id from gone_videos));
update stage_runs set retry_of = null where video_id in (select id from gone_videos);
delete from stage_runs where video_id in (select id from gone_videos);
delete from approvals where video_id in (select id from gone_videos);
delete from notifications where video_id in (select id from gone_videos);
delete from videos where id in (select id from gone_videos);

alter table videos drop constraint if exists videos_kind_check;
alter table videos add constraint videos_kind_check check (kind in ('tsx', 'collage', 'ai'));

delete from budgets where scope = 'video:scene_kit';
delete from media_routes where scope = 'kind:scene_kit';
update settings set value = value - 'scene_kit' where key = 'tracks.enabled';
