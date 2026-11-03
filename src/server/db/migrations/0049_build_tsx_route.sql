-- Phase 4 TSX slice 4: the code-scene author has its own model route, build_tsx (free-form text, no structured output
-- needed). Where an owner already chose a model for build_scene_kit and has not routed build_tsx, build_tsx starts on the same
-- model row, so a custom-animation video works without a trip to the Models page. Nothing else changes; the owner can change it.
insert into llm_routes (stage, model_id)
  select 'build_tsx', model_id from llm_routes where stage = 'build_scene_kit'
  on conflict (stage) do nothing;
