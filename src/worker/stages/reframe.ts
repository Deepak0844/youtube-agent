import { lstat } from "node:fs/promises";
import path from "node:path";
import { KnownFailure } from "@/server/core/paid-call";
import { isReframeFormat, reframeArgs, reframeFileName, reframeProblem } from "@/server/core/reframe";
import { promotedPath, type AttemptHandler } from "./attempt";
import { loadVideo, type StageDeps } from "./deps";
import { readScenesFile } from "./render";

/**
 * On demand (never in the route): re-frames the finished final.mp4 to 16:9 or 1:1 with one ffmpeg pass in the same child
 * runner as the sound mix (no network, env allow-list). final.mp4 is only read; the result is final-<fmt>.mp4, promoted
 * next to it (a second run for the same format replaces it).
 */
export function reframeAttempt(deps: StageDeps): AttemptHandler {
  return async (ctx) => {
    if (!deps.mix) throw new KnownFailure("No video tool is wired, so the video cannot be re-framed.");
    const video = await loadVideo(deps.db, ctx);
    const req = await deps.db.query<{ result: { request?: { format?: unknown } } | null }>("select result from stage_runs where id = $1", [ctx.claim.stageRunId]);
    const format = req.rows[0]?.result?.request?.format;
    if (!isReframeFormat(format)) throw new KnownFailure("The re-frame request has no valid format.");
    const input = await promotedPath(deps.root, video.id, "final.mp4");
    if (!(await lstat(input).catch(() => null))?.isFile()) throw new KnownFailure("The finished video final.mp4 is missing. Run the check step again.");
    const scenes = await readScenesFile(await promotedPath(deps.root, video.id, "scenes.json")).catch(() => null);
    const problem = reframeProblem(video.kind, scenes ? scenes.scenes.map((s) => s.kind) : []);
    if (problem) throw new KnownFailure(problem);
    const out = reframeFileName(format);
    const r = await deps.mix.runChild({
      command: "ffmpeg", args: reframeArgs(format, input, path.join(ctx.attemptDir, out)), cwd: ctx.attemptDir, cwdRoot: ctx.attemptDir,
      timeoutMs: 600_000, maxOutputBytes: 4 * 1024 * 1024, signal: ctx.signal, stageRunId: ctx.claim.stageRunId,
    });
    if (r.code !== 0 || r.truncated || r.timedOut || r.aborted) throw new KnownFailure(`The re-frame failed (ffmpeg ${r.timedOut ? "timed out" : r.aborted ? "was stopped" : "returned an error"}).`);
    return { files: [out], result: { reframed: out, format } };
  };
}
