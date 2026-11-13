---
name: openmontage-pipeline
description: Make Explainer or Animation videos the OpenMontage way - stage by stage (research, proposal, script, scene plan, assets, edit) with OpenMontage's directors, schemas, styles and checks. Use for any Explainer or Animation video.
---

# OpenMontage pipeline

OpenMontage's pipelines and guides are in `ref/openmontage/` (read-only). Follow them the way OpenMontage does.

1. Read `ref/openmontage/TOOL-MAP.md` first. Every tool, command and path in the guides maps through it. Never run a command a
   guide shows; use only the engine tools (`check_code`, `preview_frames`, `list_assets`, `fetch_asset`, `check_scenes`).
2. Pick the pipeline: `animated-explainer` (teach a topic) or `animation` (motion-led story). Read
   `ref/openmontage/pipeline_defs/<pipeline>.yaml`, then its executive producer
   (`ref/openmontage/skills/pipelines/explainer/executive-producer.md` or `.../animation/executive-producer.md`).
3. Work the stages in the pipeline's order. For each stage read its director skill (the `skill:` of the stage) and the meta
   skills it names (`ref/openmontage/skills/meta/...`, e.g. reviewer, checkpoint protocol, taste direction).
4. Write each stage's artifact to `om/<name>.json`, valid against `ref/openmontage/schemas/artifacts/<name>.schema.json`, and
   its checkpoint to `om/checkpoint_<stage>.json`.
5. Style: use the playbook `ref/openmontage/styles/<style>.yaml` the request names; set the same name as the Explainer `theme`.
6. Templated path (default): the edit stage's output is the Explainer scene list in `om/edit_decisions.json`. Run
   `check_scenes` and fix the list until its last line is `VERDICT: pass`.
   Bespoke path (only when the runtime-selector guide says the templated components cannot carry the idea): write
   `scene/video.tsx`, then `check_code` and `preview_frames`.
7. Human approvals in the guides are the app's gates: finish the artifact and checkpoint, then stop and report.
