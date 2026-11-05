-- Phase 5e slice 2: the "3D story, AI-written scene" video kind (scene3d_code). The model writes ONE React/three.js scene file that
-- is checked statically, type-checked and drawn natively in the sandbox. Its source is stored as content kind 'scenes' (already
-- allowed), so only the video kind check changes. Its author step has its own model route, author_scene3d (plain text, so Claude Code
-- works at $0), and its own per-video spend cap, both starting where code-scene (tsx) videos start. Nothing existing changes.
alter table videos drop constraint if exists videos_kind_check;
alter table videos add constraint videos_kind_check check (kind in ('scene_kit', 'tsx', 'collage', 'ai', 'scale3d', 'scene3d', 'scene3d_code'));

insert into llm_routes (stage, model_id)
  select 'author_scene3d', model_id from llm_routes where stage = 'build_tsx'
  on conflict (stage) do nothing;

insert into budgets (scope, cap_micro_usd) values ('video:scene3d_code', 5000000) on conflict (scope) do nothing;
