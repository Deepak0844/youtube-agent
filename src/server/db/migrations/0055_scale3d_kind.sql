-- Phase 5c slice 3: the 3D scale-comparison video kind. A scale3d video's description is stored as content kind 'scenes'
-- (already allowed), so only the video kind check changes. It gets its own model route, build_scale3d (plain text, so Claude Code
-- works at $0), and its own per-video spend cap, both starting where code-scene (tsx) videos start. Nothing existing changes.
alter table videos drop constraint if exists videos_kind_check;
alter table videos add constraint videos_kind_check check (kind in ('scene_kit', 'tsx', 'collage', 'ai', 'scale3d'));

insert into llm_routes (stage, model_id)
  select 'build_scale3d', model_id from llm_routes where stage = 'build_tsx'
  on conflict (stage) do nothing;

insert into budgets (scope, cap_micro_usd) values ('video:scale3d', 5000000) on conflict (scope) do nothing;
