import { lstat, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { checkToon } from "@/server/core/toon-check";
import { toonInputFor } from "@/server/core/toon-input";
import { engineModelFor } from "@/server/core/engine-config";
import { reviewRecord } from "@/server/core/frame-review";
import { KnownFailure } from "@/server/core/paid-call";
import { sanitizeCueSheet } from "@/server/core/sfx-plan";
import { checkTsx, TSX_MAX_BYTES, tsxDuration, type TsxOrientation } from "@/server/core/tsx-check";
import { tsxCaptionWords } from "@/server/core/tsx-captions";
import { targetFrames } from "@/server/core/tsx-prompt";
import { cartoonBuildRequest, explainerBuildRequest } from "@/server/engine/build-prompt";
import { EngineLimitError } from "@/server/engine/limit";
import { runEngine } from "@/server/engine/run";
import { buildEngineTools } from "@/server/engine/tools-factory";
import type { TsxRendererDeps } from "@/server/providers/renderer/tsx-render";
import type { ChildRegistry } from "@/server/render/child";
import type { AttemptHandler } from "./attempt";
import { isCartoonStyle } from "../../../remotion/kit/toon/styles";
import { latestContent } from "@/server/db/videos";
import { markSceneNoteUsed, unusedSceneNote } from "@/server/db/scene-notes";
import { loadCartoonCast, takeEngineCast } from "./cartoon";
import { loadVideo, type StageDeps } from "./deps";
import { loadTsxInputs, tsxAuthorAttempt } from "./tsx-author";
import { longEngineBuildAttempt } from "./engine-build-long";

// OpenMontage parity, Phase D1: the code-scene step done by the engine (Claude Code on the owner's subscription, ADR 0015).
// Claude gets the approved script and word times as read-only inputs and the six engine tools, draws the Explainer in
// scene/video.tsx ("Way 2", any object) and checks and previews it itself. This step then checks the file again and renders it
// through the same sandboxed renderTsx as the paid-model step, and saves the same outputs, so voice, sound and QA do not
// change. The usage limit pauses the step (EngineLimitError); the resume sweep runs it again.

export interface EngineBuildDeps {
  /** Where engine run folders live (defaultEngineRoot() in production). */
  root: string;
  /** The locked renderer's dependencies, for the engine's preview tools. */
  render: TsxRendererDeps;
  registry?: ChildRegistry;
  /** Frame orientation of the scene (L1). Production passes nothing: portrait. Landscape is off until its real run passes (no video can ask for it yet). */
  orientation?: TsxOrientation;
  /** Test seams. */
  runEngine?: typeof runEngine;
  narrationSeconds?: (file: string) => Promise<number>;
}

const SCENE = path.join("scene", "video.tsx");

/** A scene file the engine left in its work folder: a plain file (no link on the way), at most the scene size cap. `file` is relative, like scene/video.tsx or scene/ch02.tsx. */
export async function readSceneFile(workDir: string, file: string): Promise<string> {
  const missing = new KnownFailure(`The engine did not write ${file.split(path.sep).join("/")}. Run the step again.`);
  const full = path.resolve(workDir, file);
  if (!full.startsWith(workDir + path.sep)) throw missing;
  for (let p = full; p.startsWith(workDir + path.sep); p = path.dirname(p)) {
    if ((await lstat(p).catch(() => null))?.isSymbolicLink()) throw missing;
  }
  const st = await lstat(full).catch(() => null);
  if (!st?.isFile()) throw missing;
  if (st.size > TSX_MAX_BYTES) throw new KnownFailure(`The engine's ${file.split(path.sep).join("/")} is over ${TSX_MAX_BYTES / 1024} KB. Run the step again.`);
  return readFile(full, "utf8");
}
const readScene = (workDir: string): Promise<string> => readSceneFile(workDir, SCENE);

const CUES = "sfx-cues.json";
const CUES_MAX_BYTES = 64 * 1024;

/** The engine's sound cues, made safe (see sanitizeCueSheet). A missing, linked, oversized or unreadable file is an empty sheet: sound is never a reason to fail the video.
 * The result is always written, so an older attempt's cues never stay behind for a video whose timing changed. */
export async function engineCues(workDir: string, durationS: number): Promise<{ json: string; count: number; cues: ReturnType<typeof sanitizeCueSheet>["cues"] }> {
  let raw: unknown = null;
  try {
    const f = path.join(workDir, CUES);
    const st = await lstat(f);
    if (st.isFile() && st.size <= CUES_MAX_BYTES) raw = JSON.parse(await readFile(f, "utf8"));
  } catch { /* none or not JSON: no cues */ }
  const sheet = sanitizeCueSheet(raw, durationS);
  return { json: JSON.stringify(sheet), count: sheet.cues.length, cues: sheet.cues };
}

export function engineBuildAttempt(deps: StageDeps, e: EngineBuildDeps): AttemptHandler {
  return async (ctx) => {
    const video = await loadVideo(deps.db, ctx);
    if (video.kind !== "tsx") throw new KnownFailure("This video is not a code-scene video.");
    if (!deps.tsx) throw new KnownFailure("Code scenes are not set up on this worker.");
    const { beats, words, narrationS, topic } = await loadTsxInputs(deps, ctx, video.id, e.narrationSeconds);
    const want = targetFrames(narrationS);
    const orientation: TsxOrientation = e.orientation ?? "portrait";
    // A cartoon style draws with the yt-toon kit from the CURRENT beats and the series cast (a re-voiced narration moves the picture, the file is not changed).
    const cartoon = isCartoonStyle(video.style) ? video.style : null;
    const castState = cartoon ? await loadCartoonCast(deps.db, video.id) : null;
    let toon = cartoon ? toonInputFor({ beats, words, durationS: narrationS, orientation, cast: castState?.cast ?? [], style: cartoon }) : undefined;
    // The owner may have sent the scene back with a note: the engine gets the previous scene file and the note, and fixes that scene.
    const noteRow = cartoon ? await unusedSceneNote(deps.db, video.id) : null;
    const previous = noteRow ? ((await latestContent(deps.db, video.id, "tsx"))?.body as { source?: unknown } | undefined)?.source : undefined;
    const ownerNote = noteRow && typeof previous === "string" ? { note: noteRow.note, previousScene: previous } : undefined;
    const { prompt, inputs } = cartoon
      ? cartoonBuildRequest({ topic, beats, words, narrationS, style: cartoon, orientation, cast: castState?.cast ?? null, series: castState?.series ?? false, ...(ownerNote ? { ownerNote } : {}) })
      : explainerBuildRequest({ topic, beats, words, narrationS, style: video.style, format: "short", orientation });

    const r = await (e.runEngine ?? runEngine)(
      {
        db: deps.db, root: e.root, config: ctx.config.engine, registry: e.registry,
        tools: (ws) => buildEngineTools({ db: deps.db, ctx, workDir: ws.workDir, orientation, storageRoot: deps.root, render: e.render, style: video.style, ...(toon ? { toon } : {}) }),
      },
      { videoId: video.id, stageRunId: ctx.claim.stageRunId, kind: "build", prompt, inputs, long: false, signal: ctx.signal, model: engineModelFor(ctx.config, video.style) },
    );
    if (!r.ok) {
      if (r.limit) throw new EngineLimitError(r.resumeAt);
      throw new KnownFailure(r.message);
    }
    ctx.log(`engine: finished in ${r.turns} turns`);
    if (noteRow && ownerNote) await markSceneNoteUsed(deps.db, noteRow.id); // the engine read it: a retry of the step does not apply it twice

    // Checked again here, before anything renders (the engine's own check_code ran on its side of the boundary).
    const source = await readScene(r.workDir);
    const checked = checkTsx(source, orientation);
    if (!checked.ok) throw new KnownFailure(`The engine's scene file did not pass the safety check: ${checked.problems.slice(0, 3).join(" ")}`);
    if (toon) {
      // The first episode of a series made the cast: keep it (video and series) and draw with it. Then the cast names and beat marks are checked against it.
      if (castState?.series && !castState.cast) toon = { ...toon, cast: await takeEngineCast(deps.db, video.id, r.workDir) };
      const bad = checkToon(source, toon);
      if (bad.length > 0) throw new KnownFailure(`The engine's cartoon scene did not pass the check: ${bad.slice(0, 3).join(" ")}`);
    }
    const frames = tsxDuration(source);
    if (frames !== want) throw new KnownFailure(`The engine's scene file is ${frames ?? "an unknown number of"} frames; meta.durationInFrames must be ${want} (the narration length). Run the step again.`);

    const rendered = await deps.tsx.renderTsx(ctx, { source, captions: toon ? [] : tsxCaptionWords(words), style: video.style, orientation, ...(toon ? { toon } : {}), outFile: "render.mp4" });
    if (!rendered.ok) throw new KnownFailure(`The engine's scene did not render: ${[rendered.error.message, ...rendered.error.problems.slice(0, 3)].join(" ")}`);
    const cues = await engineCues(r.workDir, narrationS);
    await writeFile(path.join(ctx.attemptDir, CUES), cues.json);
    ctx.log(`engine: ${cues.count} sound cues`);
    const review = reviewRecord({ status: "skipped", reason: "frame review skipped: the engine looked at its own previews" }, 1);
    return {
      files: ["render.mp4", ...rendered.stills, CUES],
      content: [
        { kind: "tsx", body: { source, durationInFrames: frames, ...(orientation === "landscape" ? { orientation } : {}), attempts: 1, image: rendered.image, stills: rendered.stills, engine: { turns: r.turns, usage: r.usage, summary: r.text.slice(0, 2000) } } },
        { kind: "frame_review", body: review },
      ],
      result: { rendered: "render.mp4", attempts: 1, durationInFrames: frames, image: rendered.image, frameReview: review, engine: { turns: r.turns }, soundCues: cues.count },
    };
  };
}

/** The code-scene step: the engine when engine.enabled is on (Settings), otherwise the paid-model step exactly as before. */
export function codeSceneAttempt(deps: StageDeps, e: EngineBuildDeps): AttemptHandler {
  const engine = engineBuildAttempt(deps, e);
  const longEngine = longEngineBuildAttempt(deps, e);
  const paid = tsxAuthorAttempt(deps);
  return async (ctx) => {
    if (!ctx.config.engine.enabled) {
      // Cartoon styles are drawn by the engine with the yt-toon kit; the paid-model step knows only the ten yt-kit looks.
      if (isCartoonStyle((await loadVideo(deps.db, ctx)).style)) throw new KnownFailure("A cartoon video is drawn by the engine. Switch the video engine on in Settings > System, then run this step again.");
      // The paid-model step draws ONE file of at most 90 s: it cannot draw a long video, and it says so instead of failing on the length.
      if ((await loadVideo(deps.db, ctx)).format === "long") throw new KnownFailure("A long video is drawn by the engine. Switch the video engine on in Settings > System, then run this step again.");
      return paid(ctx);
    }
    return (await loadVideo(deps.db, ctx)).format === "long" ? longEngine(ctx) : engine(ctx);
  };
}
