---
name: openmontage-pipeline
description: Make Explainer or Animation videos the OpenMontage way - stage by stage (research, proposal, script, scene plan, assets, edit) with OpenMontage's directors, schemas, styles and checks. Use for any Explainer or Animation video.
---

# OpenMontage pipeline

OpenMontage's pipelines and guides are in `ref/openmontage/` (read-only). Follow them the way OpenMontage does.

1. Read `ref/openmontage/TOOL-MAP.md` first. Every tool, command and path in the guides maps through it. Never run a command a
   guide shows; use only the engine tools (`check_code`, `preview_frames`, `check_scenes`, `preview_scenes`, `list_assets`, `fetch_asset`).
2. Pick the pipeline: `animated-explainer` (teach a topic) or `animation` (motion-led story). Read
   `ref/openmontage/pipeline_defs/<pipeline>.yaml`, then its executive producer
   (`ref/openmontage/skills/pipelines/explainer/executive-producer.md` or `.../animation/executive-producer.md`).
3. Work the stages in the pipeline's order. For each stage read its director skill (the `skill:` of the stage) and the meta
   skills it names (`ref/openmontage/skills/meta/...`, e.g. reviewer, checkpoint protocol, taste direction).
4. Write each stage's artifact to `om/<name>.json`, valid against `ref/openmontage/schemas/artifacts/<name>.schema.json`, and
   its checkpoint to `om/checkpoint_<stage>.json`.
5. Style: use the playbook `ref/openmontage/styles/<style>.yaml` the request names; set the same name as the Explainer `theme`.
6. **Explainer videos are drawn (bespoke path) by default**: write `scene/video.tsx` and draw the objects the script talks
   about with the `draw-objects` skill, in the style's colours and fonts and OpenMontage's pacing. Use the templated path
   only for a data-only video or when the request asks for it.
   Templated path: the edit stage writes `om/edit_decisions.json` (valid against its schema); the compose stage's
   "assemble composition JSON" step writes the Explainer composition to `om/composition.json`, built from the
   composer's own scene types (`ref/openmontage/remotion-composer/SCENE_TYPES.md`, examples in
   `ref/openmontage/remotion-composer/public/demo-props/`; see TOOL-MAP "Writing the Explainer scene list"). Run
   `check_scenes` and fix the files until its last line is `VERDICT: pass`; then `preview_scenes` (about one frame per
   scene), look at every frame as OpenMontage's compose director asks, and revise. Never render the video; the app does.
   Bespoke path: write `scene/video.tsx`, then `check_code` and `preview_frames` (see `draw-objects`).
7. Human approvals in the guides are the app's gates: finish the artifact and checkpoint, then stop and report.
