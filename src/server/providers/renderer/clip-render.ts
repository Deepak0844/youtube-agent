import { randomBytes } from "node:crypto";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { isTsxStyleId } from "../../../../remotion/kit/tsxlib/styledata";
import type { StageContext } from "@/server/core/stage-handler";
import { daemonLimits, RENDER_IMAGE } from "@/server/render/runner";
import { mountable, NAME_PREFIX, realDir, renderArgs, runRenderContainer } from "./remotion-container";
import { copyRegular } from "@/server/storage/regular-file";
import { stagePublicAssets, type TsxRendererDeps } from "./tsx-render";
import { TSX_EXTRA_FLAGS, TSX_SANDBOX } from "./tsx-sandbox";

// Clip Factory CF2b. Draws the app's captions over a finished 1080x1920 clip (made by core/clip-cut.ts) in the locked render
// container (render-entry.mjs --clip). The composition is fixed code from the read-only kit: NO model-written code runs here, so
// the limits are the kit render's own (a decoded video needs more than the TSX sandbox's 2 GB; at 2 GB Chromium crashed), with the
// same locks, the file-size cap and no network. /in holds only meta.json and public/clip.mp4.
const FPS = 30;
const MAX_CLIP_FRAMES = 30 * 180;
const MAX_CAPTION_WORDS = 1500;
const MAX_MESSAGE = 300;

export interface ClipRenderInput {
  /** The cut, reframed clip: an absolute host path (copied into the job folder, never mounted; no symlink followed). */
  clipFile: string;
  /** Word times shifted to start at 0 for this clip. */
  captions: { word: string; startS: number; endS: number }[];
  /** The video's style id (unknown or empty = ai_studio). */
  style?: string | null;
  /** The clip's length in seconds (from the cut: endS - startS). */
  durationS: number;
  /** A plain file name inside ctx.attemptDir. */
  outFile: string;
}
export type ClipRenderResult = { ok: true; outPath: string; image: string } | { ok: false; message: string };

export async function renderClip(deps: TsxRendererDeps, ctx: StageContext, input: ClipRenderInput): Promise<ClipRenderResult> {
  if (input.outFile === "" || input.outFile !== path.basename(input.outFile) || input.outFile.startsWith(".")) throw new Error("outFile must be a plain file name");
  const fail = (message: string): ClipRenderResult => ({ ok: false, message: message.slice(0, MAX_MESSAGE) });
  const aborted = () => ctx.signal.reason ?? new Error("render aborted");
  const frames = Math.round(input.durationS * FPS);
  if (!Number.isFinite(frames) || frames < 1 || frames > MAX_CLIP_FRAMES) return fail("A clip must be between 1 frame and 180 seconds long.");
  const words = input.captions.slice(0, MAX_CAPTION_WORDS).filter((w) => typeof w.word === "string" && w.word.length <= 60 && Number.isFinite(w.startS) && Number.isFinite(w.endS));

  const inDir = mountable(path.join(ctx.attemptDir, "clip-in"));
  const outDir = mountable(path.join(ctx.attemptDir, "clip-out"));
  const cleanup = () => Promise.all([inDir, outDir].map((d) => rm(d, { recursive: true, force: true }))).catch(() => undefined);
  await cleanup();
  try {
    const publicDir = path.join(inDir, "public");
    let kitDir: string | undefined;
    try {
      if (deps.kitDir !== undefined) { // dev override only; production renders use the kit baked into the image
        kitDir = mountable(deps.kitDir);
        await realDir(kitDir, "kit");
      }
      await mkdir(publicDir, { recursive: true, mode: 0o755 });
      await chmod(inDir, 0o755);
      await chmod(publicDir, 0o755);
      await mkdir(outDir, { mode: 0o700 });
      await chmod(outDir, 0o777); // the container runs as uid 10001; this folder holds nothing else
      await writeFile(path.join(inDir, "meta.json"), JSON.stringify({ durationInFrames: frames, captions: words, ...(isTsxStyleId(input.style) ? { style: input.style } : {}) }), { mode: 0o644, flag: "wx" });
    } catch (e) {
      return fail(`The clip render folders could not be prepared (${e instanceof Error ? e.message : "unknown"}).`);
    }
    const staged = await stagePublicAssets(publicDir, { "clip.mp4": input.clipFile });
    if (staged) return fail(staged.replace(/'[^']*'/g, "the clip"));
    try {
      await realDir(inDir, "input");
      await realDir(outDir, "output");
    } catch (e) {
      return fail(e instanceof Error ? e.message : "The render folders are not usable.");
    }

    const host = await (deps.hostLimits ?? daemonLimits)();
    const image = deps.image ? await deps.image() : { ref: RENDER_IMAGE, pinned: false };
    if (!image.pinned) ctx.log(`render: image not pinned (could not resolve its id); running the tag ${image.ref}`);
    const c = ctx.config.render;
    for (const v of [c.timeoutS, c.cpus, c.memoryMb, c.pids]) if (!Number.isFinite(v) || v <= 0) return fail("The render settings are not usable for a clip render.");
    const name = `${NAME_PREFIX}${ctx.claim.stageRunId.replace(/[^a-zA-Z0-9_.-]/g, "").slice(0, 36)}-clip-${randomBytes(4).toString("hex")}`;
    const args = renderArgs({
      name, host, imageRef: image.ref, workerId: deps.workerId, inDir, outDir, kitDir, hostPath: deps.hostPath,
      limits: { cpus: c.cpus, memoryMb: c.memoryMb, pids: c.pids }, extra: TSX_EXTRA_FLAGS, entry: ["/in", "/out/out.mp4", "--clip"],
    });
    const timeoutMs = Math.floor(c.timeoutS) * 1000;
    const { r, tail } = await runRenderContainer(deps, ctx, { name, args, timeoutMs, maxOutputBytes: TSX_SANDBOX.maxOutputBytes });
    if (r.aborted) throw aborted();
    if (r.timedOut) return fail(`The clip render took longer than its ${Math.round(timeoutMs / 1000)} s limit and was stopped.`);
    if (r.truncated) return fail("The clip render printed too much output and was stopped.");
    if (r.code !== 0) return fail(`The clip render failed (exit ${r.code ?? r.signal}). ${tail.slice(-2).join(" ")}`);

    const outPath = path.join(ctx.attemptDir, input.outFile);
    await rm(outPath, { force: true });
    try {
      await copyRegular(path.join(outDir, "out.mp4"), outPath, TSX_SANDBOX.maxFileBytes);
    } catch (e) {
      return fail(e instanceof Error && /bigger than/.test(e.message) ? "The rendered clip is too big." : "The render finished but made no video file.");
    }
    let p;
    try {
      p = await deps.probe(outPath, ctx.signal);
    } catch {
      if (ctx.signal.aborted) throw aborted();
      return fail("The rendered file is not a readable video.");
    }
    if (p.width !== 1080 || p.height !== 1920) return fail(`The clip render is ${p.width}x${p.height}, expected 1080x1920.`);
    if (!(p.durationS > 0)) return fail("The rendered clip is empty.");
    if (Math.abs(p.durationS - frames / FPS) > 1) return fail(`The clip is ${p.durationS.toFixed(1)} s but was cut to ${(frames / FPS).toFixed(1)} s.`);
    return { ok: true, outPath, image: image.ref };
  } finally {
    await cleanup();
  }
}
