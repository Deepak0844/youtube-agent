import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { reviewRecord } from "@/server/core/frame-review";
import { KnownFailure } from "@/server/core/paid-call";
import { checkTsx, TSX_MAX_BYTES, tsxDuration } from "@/server/core/tsx-check";
import { tsxCaptionWords } from "@/server/core/tsx-captions";
import { targetFrames } from "@/server/core/tsx-prompt";
import { explainerBuildRequest } from "@/server/engine/build-prompt";
import { EngineLimitError } from "@/server/engine/limit";
import { runEngine } from "@/server/engine/run";
import { buildEngineTools } from "@/server/engine/tools-factory";
import type { TsxRendererDeps } from "@/server/providers/renderer/tsx-render";
import type { ChildRegistry } from "@/server/render/child";
import type { AttemptHandler } from "./attempt";
import { loadVideo, type StageDeps } from "./deps";
import { loadTsxInputs, tsxAuthorAttempt } from "./tsx-author";

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
  /** Test seams. */
  runEngine?: typeof runEngine;
  narrationSeconds?: (file: string) => Promise<number>;
}

const SCENE = path.join("scene", "video.tsx");

/** The scene file the engine left in its work folder: a plain file (no link on the way), at most the scene size cap. */
async function readScene(workDir: string): Promise<string> {
  const missing = new KnownFailure("The engine did not write scene/video.tsx. Run the step again.");
  for (let p = path.join(workDir, SCENE); p.startsWith(workDir + path.sep); p = path.dirname(p)) {
    if ((await lstat(p).catch(() => null))?.isSymbolicLink()) throw missing;
  }
  const st = await lstat(path.join(workDir, SCENE)).catch(() => null);
  if (!st?.isFile()) throw missing;
  if (st.size > TSX_MAX_BYTES) throw new KnownFailure(`The engine's scene/video.tsx is over ${TSX_MAX_BYTES / 1024} KB. Run the step again.`);
  return readFile(path.join(workDir, SCENE), "utf8");
}

export function engineBuildAttempt(deps: StageDeps, e: EngineBuildDeps): AttemptHandler {
  return async (ctx) => {
    const video = await loadVideo(deps.db, ctx);
    if (video.kind !== "tsx") throw new KnownFailure("This video is not a code-scene video.");
    if (!deps.tsx) throw new KnownFailure("Code scenes are not set up on this worker.");
    const { beats, words, narrationS, topic } = await loadTsxInputs(deps, ctx, video.id, e.narrationSeconds);
    const want = targetFrames(narrationS);
    const { prompt, inputs } = explainerBuildRequest({ topic, beats, words, narrationS, style: video.style, format: "short" });

    const r = await (e.runEngine ?? runEngine)(
      {
        db: deps.db, root: e.root, config: ctx.config.engine, registry: e.registry,
        tools: (ws) => buildEngineTools({ db: deps.db, ctx, workDir: ws.workDir, orientation: "portrait", storageRoot: deps.root, render: e.render, style: video.style }),
      },
      { videoId: video.id, stageRunId: ctx.claim.stageRunId, kind: "build", prompt, inputs, long: false, signal: ctx.signal },
    );
    if (!r.ok) {
      if (r.limit) throw new EngineLimitError(r.resumeAt);
      throw new KnownFailure(r.message);
    }
    ctx.log(`engine: finished in ${r.turns} turns`);

    // Checked again here, before anything renders (the engine's own check_code ran on its side of the boundary).
    const source = await readScene(r.workDir);
    const checked = checkTsx(source);
    if (!checked.ok) throw new KnownFailure(`The engine's scene file did not pass the safety check: ${checked.problems.slice(0, 3).join(" ")}`);
    const frames = tsxDuration(source);
    if (frames !== want) throw new KnownFailure(`The engine's scene file is ${frames ?? "an unknown number of"} frames; meta.durationInFrames must be ${want} (the narration length). Run the step again.`);

    const rendered = await deps.tsx.renderTsx(ctx, { source, captions: tsxCaptionWords(words), style: video.style, outFile: "render.mp4" });
    if (!rendered.ok) throw new KnownFailure(`The engine's scene did not render: ${[rendered.error.message, ...rendered.error.problems.slice(0, 3)].join(" ")}`);
    const review = reviewRecord({ status: "skipped", reason: "frame review skipped: the engine looked at its own previews" }, 1);
    return {
      files: ["render.mp4", ...rendered.stills],
      content: [
        { kind: "tsx", body: { source, durationInFrames: frames, attempts: 1, image: rendered.image, stills: rendered.stills, engine: { turns: r.turns, usage: r.usage, summary: r.text.slice(0, 2000) } } },
        { kind: "frame_review", body: review },
      ],
      result: { rendered: "render.mp4", attempts: 1, durationInFrames: frames, image: rendered.image, frameReview: review, engine: { turns: r.turns } },
    };
  };
}

/** The code-scene step: the engine when engine.enabled is on (Settings), otherwise the paid-model step exactly as before. */
export function codeSceneAttempt(deps: StageDeps, e: EngineBuildDeps): AttemptHandler {
  const engine = engineBuildAttempt(deps, e);
  const paid = tsxAuthorAttempt(deps);
  return (ctx) => (ctx.config.engine.enabled ? engine(ctx) : paid(ctx));
}
