# OpenMontage in this app: tool and path map

You are running OpenMontage's pipelines and guides (this folder, `ref/openmontage/`) inside YT Studio's engine. The guides were
written for OpenMontage's own Python tools and project folders. Those do not exist here. Read every tool name, command and path
in a guide through this map. **Never run any command a guide shows** (scripts, CLIs, registry calls, installers): the engine's
tools below are the only way to check, preview or fetch anything.

Engine tools you have: `check_code`, `preview_frames`, `check_scenes`, `preview_scenes`, `list_assets`, `fetch_asset`.

## Paths

| In a guide | Here |
|---|---|
| `skills/...`, `pipeline_defs/...`, `schemas/...`, `styles/...` | `ref/openmontage/skills/...` and so on (read-only) |
| `projects/<slug>/` (the project folder) | your work folder (the current folder) |
| `projects/<slug>/artifacts/<name>.json`, stage artifacts | `om/<name>.json`, named as the schema names it (`brief.json`, `research_brief.json`, `proposal_packet.json`, `script.json`, `scene_plan.json`, `asset_manifest.json`, `edit_decisions.json`, ...) |
| `composition.json`, `composition_path` (the Remotion props the compose stage assembles) | `om/composition.json` |
| `projects/<id>/checkpoint_<stage>.json`, `write_checkpoint(...)` | write `om/checkpoint_<stage>.json` yourself, with the fields the checkpoint protocol lists |
| `projects/<slug>/assets/...`, `public/...` | `assets/` (filled by `fetch_asset`); refer to files by their name inside `assets/` |
| `projects/<slug>/index.tsx` (a bespoke or "atelier" composition) | `scene/video.tsx`, checked with `check_code` and previewed with `preview_frames`; it may use the composer's own components as `yt-om/<Component>` (list and props: `ref/openmontage/COMPONENTS.md`) |
| `projects/<project-name>/skills/<name>.md` (project skills) | not used |
| `remotion-composer/public/...` (where OpenMontage stages files) | `assets/` |
| `remotion-composer/src/...`, `src/Explainer.tsx`, `src/components/...` | not readable here; `ref/openmontage/remotion-composer/SCENE_TYPES.md` is the contract of what the composer draws, and `ref/openmontage/COMPONENTS.md` lists the components a bespoke scene may import (`yt-om/<Component>`) |
| `AGENT_GUIDE.md` | `ref/openmontage/AGENT_GUIDE.md`; where it conflicts with this map (tools, runtimes, commands), this map wins |

## Tools

| OpenMontage tool or command | Here | Available |
|---|---|---|
| `video_compose`, `remotion_render`, `npx remotion render Explainer` | Do the compose stage's "assemble composition JSON" step: write `om/composition.json` (the `cuts`, `overlays`, `captions`, `audio`, `theme` the Explainer composition takes) and run `check_scenes`. Do not render: the app renders it after your run. | yes, as described |
| `npx remotion still`, `atelier_snapshots`, snapshots of a composition | `preview_scenes` (frames of `om/composition.json`, with its playbook theme, at the video's size); for a bespoke `scene/video.tsx`, `preview_frames` | yes |
| `scaffold_atelier_project` | create `scene/video.tsx` yourself | yes |
| `composition_validator`, `score_slideshow_risk`, `slideshow_risk`, delivery promise checks | `check_scenes` | yes |
| `tts_selector`, `openai_tts`, `google_tts`, `elevenlabs_tts`, `azure_tts`, voice providers | not called by you: the app narrates the approved script in its voice step and gives you word times | app does it |
| `subtitle_gen`, `subtitle_check` | not called by you: the app makes captions from the narration's word times | app does it |
| `image_selector`, `image_gen`, `diagram_gen`, image providers | no generated pictures. Use the composer's scenes (cards, charts, terminal, stat reveals), or `list_assets` kind `image` then `fetch_asset` | partly |
| `video_gen`, video generation providers | not available in a build run: use component scenes or library clips | no |
| `video_selector`, stock footage, `pexels_url` | `list_assets` kind `video` then `fetch_asset` | yes |
| `music_gen`, `music_search`, `pixabay_music` | `list_assets` kind `music` then `fetch_asset` | yes |
| sound effects | `list_assets` kind `sfx` then `fetch_asset` | yes |
| `web_search` | only in the app's research run (the draft step); not in a build run | research run only |
| `visual_accuracy_check` | `preview_scenes` (or `preview_frames` for a bespoke scene), and look at the frames yourself | yes |
| `audio_probe`, `audio_duration_seconds` | `check_scenes` reports narration and music lengths against the video | yes |
| `audio_mixer`, `video_stitch`, `export_bundle` | not needed: the app mixes, joins and exports | app does it |
| `hyperframes_compose`, any `npx hyperframes ...` | not available: Remotion only | no |
| `runtime_swap_check` | not needed: Remotion only | no |
| `audio_energy` | not available: set music `offsetSeconds` by ear from the track's description, or leave it 0 | no |
| `cost_tracker`, `estimate_cost` | not needed: everything here is free and local; the app asks the owner before any paid step | no |
| `technical_probe` (a field of `source_media_review`) | not used: Explainer and Animation videos have no footage of yours to review | n/a |
| the tool registry (`tools.tool_registry`, `install_instructions`) | this map is the registry | n/a |

## Explainers are drawn

In this app an Explainer is drawn in code by default (owner decision): `scene/video.tsx` with the objects the script talks
about, built with the `draw-objects` skill, in the style's colours (`ref/openmontage/themes/<style>.json`). Where a guide
says the runtime selector should pick the templated Explainer composition, prefer the bespoke path unless the video is
data-only. OpenMontage's stage structure, pacing, style playbook and checks still apply.

## Writing the Explainer composition (`om/composition.json`)

`om/edit_decisions.json` is the edit artifact and must stay valid against its schema (its cuts carry timing, `reason` and
`source` only; `renderer_family`, `render_runtime` and `metadata.delivery_promise` live there). The scene components and their
fields go in `om/composition.json`, built from the edit decisions and the scene plan, exactly as the compose stage does.

The look comes from the composer's own scene components. Use them; do not draw your own pictures for a scene.

- A component cut has a `type` from `ref/openmontage/remotion-composer/SCENE_TYPES.md` and that type's required fields, and no
  `source`: e.g. `{"id": "hook", "type": "hero_title", "text": "...", "heroSubtitle": "...", "in_seconds": 0, "out_seconds": 4}`.
- Types this app's composer draws: `text_card`, `hero_title`, `stat_card`, `callout`, `comparison`, `bar_chart`, `line_chart`,
  `pie_chart`, `kpi_grid`, `progress_bar`, `terminal_scene`. Overlays: `section_title`, `stat_reveal`, `hero_title`.
  Not here: `anime_scene`, `screenshot_scene` and the `provider_chip` overlay.
- `source` is only for a real staged file in `assets/` (`.png`, `.jpg`, `.jpeg`, `.webp`, `.mp4`, from `fetch_asset`). Never
  put a component name in `source`, and never hand-write images (SVG cannot be staged).
- Worked examples, exactly as OpenMontage writes them: `ref/openmontage/remotion-composer/public/demo-props/*.json`.
- Motion: the components animate themselves. Component scenes are "animated slides" for the delivery promise; a
  `teacher_explainer` or `data_explainer` promise does not need footage, so do not set `motion_required` unless real footage is
  planned. `check_scenes` refuses unknown types, missing required fields and unusable sources.

## Human checkpoints

Where a guide says to stop for human approval, the app's gates do that: finish the stage's artifact, write its checkpoint,
then stop and report what you made. Do not wait inside the run.

## Guides not included

These guides are named in OpenMontage's files but are not in this app, because they belong to left-out runtimes (HyperFrames,
Manim, Three.js, GSAP, Lottie), left-out pipelines (cinematic), paid generation, or other licences. Skip any step that needs
them; for Remotion craft use your own Remotion knowledge and the Explainer composer's scenes.

- `skills/3d-asset-generation`, `skills/threejs-world-generation`, `skills/creative/3d-world-generation.md`
- `skills/beautiful-mermaid`, `skills/d3-viz`, `skills/framer-motion`, `skills/lottie-bodymovin`, `skills/motion-graphics`
- `skills/flux-best-practices`, `skills/creative/video-gen-prompting.md`, `skills/media-use`, `skills/music-to-video`
- `skills/gsap-core`, `skills/gsap-plugins`, `skills/gsap-react`, `skills/gsap-timeline`
- `skills/hyperframes`, `skills/hyperframes-animation`, `skills/hyperframes-cli`, `skills/hyperframes-core`, `skills/hyperframes-creative`, `skills/hyperframes-media`, `skills/hyperframes-registry`, `skills/remotion-to-hyperframes`, `skills/core/hyperframes.md`
- `skills/manim-composer`, `skills/manimce-best-practices`
- `skills/remotion`, `skills/remotion-best-practices` (OpenMontage keeps these under `.agents/skills/`)
- `skills/synthetic-screen-recording`, `skills/website-to-video`, `skills/creative/ink-theater.md`, `skills/styles`
- `skills/core/ffmpeg.md`, `skills/meta/skill-creator.md`, `skills/meta/video-reference-analyst.md`
- `skills/pipelines/cinematic/...` (comes with the Cinematic step)
- `skills/meta/onboarding.md`, `skills/creative/commercial-product-video.md`, `skills/creative/animated-drawing.md`, `skills/synthetic-ui-recording`
- `pipeline_defs/screen-demo.yaml`, `skills/pipelines/screen-demo` (Screen Demo is not part of this app)
- `schemas/pipelines`, `schemas/styles`, `styles/ink-sketch.yaml`, `styles/playbook_loader.py`
- `remotion-composer/src`, `remotion-composer/projects` (the composer's code is in the render box; SCENE_TYPES.md is its contract)
- `PROJECT_CONTEXT.md`
- anything under `.agents/skills/`
