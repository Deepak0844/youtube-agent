# OpenMontage in this app: tool and path map

You are running OpenMontage's pipelines and guides (this folder, `ref/openmontage/`) inside YT Studio's engine. The guides were
written for OpenMontage's own Python tools and project folders. Those do not exist here. Read every tool name, command and path
in a guide through this map. **Never run any command a guide shows** (scripts, CLIs, registry calls, installers): the engine's
tools below are the only way to check, preview or fetch anything.

Engine tools you have: `check_code`, `preview_frames`, `list_assets`, `fetch_asset`, `check_scenes`.

## Paths

| In a guide | Here |
|---|---|
| `skills/...`, `pipeline_defs/...`, `schemas/...`, `styles/...` | `ref/openmontage/skills/...` and so on (read-only) |
| `projects/<slug>/` (the project folder) | your work folder (the current folder) |
| `projects/<slug>/artifacts/<name>.json`, stage artifacts | `om/<name>.json`, named as the schema names it (`brief.json`, `research_brief.json`, `proposal_packet.json`, `script.json`, `scene_plan.json`, `asset_manifest.json`, `edit_decisions.json`, ...) |
| `projects/<id>/checkpoint_<stage>.json`, `write_checkpoint(...)` | write `om/checkpoint_<stage>.json` yourself, with the fields the checkpoint protocol lists |
| `projects/<slug>/assets/...`, `public/...` | `assets/` (filled by `fetch_asset`); refer to files by their name inside `assets/` |
| `projects/<slug>/index.tsx` (a bespoke or "atelier" composition) | `scene/video.tsx`, checked with `check_code` and previewed with `preview_frames` |
| `projects/<project-name>/skills/<name>.md` (project skills) | not used |

## Tools

| OpenMontage tool or command | Here | Available |
|---|---|---|
| `video_compose`, `remotion_render`, `npx remotion render Explainer` | Write the Explainer scene list to `om/edit_decisions.json` (the `cuts`, `overlays`, `captions`, `audio`, `theme` the Explainer composition takes) and run `check_scenes`. The app renders it after your run. | yes, as described |
| `npx remotion still`, `atelier_snapshots`, snapshots of a composition | `preview_frames` on `scene/video.tsx` | yes |
| `scaffold_atelier_project` | create `scene/video.tsx` yourself | yes |
| `composition_validator`, `score_slideshow_risk`, `slideshow_risk`, delivery promise checks | `check_scenes` | yes |
| `tts_selector`, `openai_tts`, `google_tts`, `elevenlabs_tts`, voice providers | not called by you: the app narrates the approved script in its voice step and gives you word times | app does it |
| `subtitle_gen`, `subtitle_check` | not called by you: the app makes captions from the narration's word times | app does it |
| `image_selector`, `image_gen`, `diagram_gen`, image providers | no generated pictures. Use the composer's scenes (cards, charts, terminal, stat reveals), or `list_assets` kind `image` then `fetch_asset` | partly |
| `video_selector`, stock footage, `pexels_url` | `list_assets` kind `video` then `fetch_asset` | yes |
| `music_gen`, `music_search`, `pixabay_music` | `list_assets` kind `music` then `fetch_asset` | yes |
| sound effects | `list_assets` kind `sfx` then `fetch_asset` | yes |
| `web_search` | only in the app's research run (the draft step); not in a build run | research run only |
| `visual_accuracy_check` | `preview_frames`, and look at the frames yourself | yes |
| `audio_probe`, `audio_duration_seconds` | `check_scenes` reports narration and music lengths against the video | yes |
| `audio_mixer`, `video_stitch`, `export_bundle` | not needed: the app mixes, joins and exports | app does it |
| `hyperframes_compose`, any `npx hyperframes ...` | not available: Remotion only | no |
| `runtime_swap_check` | not needed: Remotion only | no |
| `audio_energy` | not available: set music `offsetSeconds` by ear from the track's description, or leave it 0 | no |
| `cost_tracker`, `estimate_cost` | not needed: everything here is free and local; the app asks the owner before any paid step | no |
| `technical_probe` (a field of `source_media_review`) | not used: Explainer and Animation videos have no footage of yours to review | n/a |
| the tool registry (`tools.tool_registry`, `install_instructions`) | this map is the registry | n/a |

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
- anything under `.agents/skills/`
