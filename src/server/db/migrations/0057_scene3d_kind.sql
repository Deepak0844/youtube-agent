-- Phase 5d slice D1: the general 3D scene video kind. A scene3d video's scene is stored as content kind 'scenes' (already allowed),
-- so only the video kind check changes. Its director step has its own model route, direct_scene3d (plain text, so Claude Code works
-- at $0), and its own per-video spend cap, both starting where code-scene (tsx) videos start. Nothing existing changes.
alter table videos drop constraint if exists videos_kind_check;
alter table videos add constraint videos_kind_check check (kind in ('scene_kit', 'tsx', 'collage', 'ai', 'scale3d', 'scene3d'));

insert into llm_routes (stage, model_id)
  select 'direct_scene3d', model_id from llm_routes where stage = 'build_tsx'
  on conflict (stage) do nothing;

insert into budgets (scope, cap_micro_usd) values ('video:scene3d', 5000000) on conflict (scope) do nothing;
