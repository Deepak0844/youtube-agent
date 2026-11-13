import { randomBytes } from "node:crypto";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { StageContext } from "@/server/core/stage-handler";
import { daemonLimits, RENDER_IMAGE } from "@/server/render/runner";
import { ASSET_EXT, AUDIO_EXT, copyRegular, mountable, NAME_PREFIX, realDir, runRenderContainer } from "./remotion-container";
import { stagePublicAssets, type TsxRendererDeps } from "./tsx-render";
import { TSX_SANDBOX, tsxRenderPlan } from "./tsx-sandbox";

// SECURITY CONTROL (ADR 0009): draws an OpenMontage scene list (cuts, overlays, captions, audio: plain JSON, no code) with
// OpenMontage's own Explainer composition (remotion/kit/om, AGPL-3.0, copied plus patches) in the same locked container and
// limits as a TSX render. Only staged files are reachable (om/lib/resolveAsset.ts is patched to staticFile names only).
// Returns a typed failure instead of throwing; only a cancelled stage throws.

const FPS = 30;
const MAX_FRAMES = FPS * 60 * 12; // render-entry.mjs OM_MAX_FRAMES
const MAX_PROPS_BYTES = 512 * 1024;
const MAX_CUTS = 300;
const MAX_STILL_BYTES = 32 * 1024 * 1024;
const OM_EXT: ReadonlySet<string> = new Set([...ASSET_EXT, ...AUDIO_EXT]);
/** The cut types om/Explainer.tsx draws and the fields each needs (its dispatch conditions); without them a cut draws nothing. */
export const OM_CUT_TYPES: Readonly<Record<string, readonly string[]>> = {
  text_card: ["text"], hero_title: ["text"], callout: ["text"], stat_card: ["stat"], comparison: ["leftLabel", "leftValue", "rightLabel", "rightValue"],
  terminal_scene: ["steps"], bar_chart: ["chartData"], pie_chart: ["chartData"], kpi_grid: ["chartData"], line_chart: ["chartSeries"], progress_bar: ["progress"],
};
export const OM_OVERLAY_TYPES: readonly string[] = ["section_title", "stat_reveal", "hero_title"];
const SOURCE_EXT = [".png", ".jpg", ".jpeg", ".webp", ".mp4"];
export const OM_SIZE = { landscape: { width: 1920, height: 1080 }, portrait: { width: 1080, height: 1920 } } as const;

export interface OmRenderInput {
  /** The OpenMontage scene list: cuts, overlays, captions, audio, theme / themeConfig, as OpenMontage's Explainer takes it. */
  props: Record<string, unknown>;
  orientation: keyof typeof OM_SIZE;
  /** staticFile() name -> absolute host path (images, clips, narration, music). Copied, never mounted. */
  assets?: Record<string, string>;
  /** A plain file name inside ctx.attemptDir for the video. */
  outFile: string;
  /** Draw ONLY these frames (1-8) as om-frame-<n>.png in ctx.attemptDir and stop; no video. */
  stills?: readonly number[];
}
export type OmRenderResult = { ok: true; outPath: string; stills: string[]; image: string } | { ok: false; message: string; problems: string[] };

/** The video length in frames, as om/Root.tsx's calculateMetadata computes it (empty list = 60 s). */
export function omDurationFrames(props: Record<string, unknown>): number {
  const cuts = Array.isArray(props.cuts) ? (props.cuts as Array<{ out_seconds?: unknown }>) : [];
  if (cuts.length === 0) return FPS * 60;
  const lastEnd = Math.max(...cuts.map((c) => (typeof c?.out_seconds === "number" ? c.out_seconds : 0)));
  const tail = typeof props.tailPaddingSeconds === "number" ? props.tailPaddingSeconds : 1;
  return Math.ceil((lastEnd + tail) * FPS);
}

/** Problems with a scene list's shape (not its look); empty = usable. */
export function checkOmProps(props: unknown): string[] {
  if (typeof props !== "object" || props === null || Array.isArray(props)) return ["The scene list is not a JSON object."];
  const p = props as Record<string, unknown>;
  const problems: string[] = [];
  if (Buffer.byteLength(JSON.stringify(p)) > MAX_PROPS_BYTES) problems.push("The scene list is bigger than 512 KB.");
  if (!Array.isArray(p.cuts) || p.cuts.length === 0) return [...problems, "The scene list has no cuts."];
  if (p.cuts.length > MAX_CUTS) problems.push(`The scene list has more than ${MAX_CUTS} cuts.`);
  p.cuts.forEach((c: unknown, i) => {
    const cut = c as Record<string, unknown> | null;
    const a = cut?.in_seconds;
    const b = cut?.out_seconds;
    if (typeof cut?.id !== "string" || (typeof cut.type !== "string" && typeof cut.source !== "string")) problems.push(`Cut ${i} needs an id and a type or source.`);
    if (typeof a !== "number" || typeof b !== "number" || !(a >= 0) || !(b > a)) problems.push(`Cut ${i} needs 0 <= in_seconds < out_seconds.`);
    if (!cut) return;
    const who = `Cut ${i} (${String(cut.id)})`;
    const type = cut.type;
    if (typeof type === "string" && type !== "") {
      const need = OM_CUT_TYPES[type];
      if (!Object.hasOwn(OM_CUT_TYPES, type) || !need) problems.push(`${who}: type '${type}' is not a scene type of this app's composer (see remotion-composer/SCENE_TYPES.md).`);
      else if (need.some((f) => cut[f] === undefined || cut[f] === null || cut[f] === "")) problems.push(`${who}: a ${type} needs ${need.join(", ")}.`);
    } else if (typeof cut.source === "string" && cut.source !== "" && !SOURCE_EXT.some((e) => (cut.source as string).toLowerCase().endsWith(e))) {
      problems.push(`${who}: source '${cut.source.slice(0, 80)}' must be a staged .png, .jpg, .jpeg, .webp or .mp4 file.`);
    }
  });
  (Array.isArray(p.overlays) ? p.overlays : []).forEach((o: unknown, i) => {
    const ov = (o ?? {}) as Record<string, unknown>;
    if (typeof ov.type !== "string" || !OM_OVERLAY_TYPES.includes(ov.type)) problems.push(`Overlay ${i}: type '${String(ov.type)}' is not an overlay type of this app's composer (${OM_OVERLAY_TYPES.join(", ")}).`);
    else if (typeof ov.text !== "string" || ov.text === "") problems.push(`Overlay ${i}: a ${ov.type} needs text.`);
  });
  if (problems.length === 0 && omDurationFrames(p) > MAX_FRAMES) problems.push("The video is longer than 12 minutes.");
  return problems.slice(0, 10);
}

export async function renderOm(deps: TsxRendererDeps, ctx: StageContext, input: OmRenderInput): Promise<OmRenderResult> {
  if (input.outFile === "" || input.outFile !== path.basename(input.outFile) || input.outFile.startsWith(".")) throw new Error("outFile must be a plain file name");
  const failure = (message: string, problems: string[] = []): OmRenderResult => ({ ok: false, message, problems: problems.slice(0, 10) });
  const aborted = () => ctx.signal.reason ?? new Error("render aborted");
  const size = OM_SIZE[input.orientation];
  if (!size) return failure("The orientation must be landscape or portrait.");
  const shape = checkOmProps(input.props);
  if (shape.length > 0) return failure("The scene list is not usable.", shape);
  const frames = omDurationFrames(input.props);
  const stills = input.stills ? [...new Set(input.stills)] : [];
  if (input.stills) {
    const bad = stills.find((f) => !Number.isInteger(f) || f < 0 || f >= frames);
    if (stills.length < 1 || stills.length > 8 || bad !== undefined) return failure(bad !== undefined ? `Frame ${bad} is outside the video (0-${frames - 1}).` : "Ask for 1 to 8 frames.");
  }

  const inDir = mountable(path.join(ctx.attemptDir, "om-in"));
  const outDir = mountable(path.join(ctx.attemptDir, "om-out"));
  const publicDir = path.join(inDir, "public");
  const cleanup = () => Promise.all([inDir, outDir].map((d) => rm(d, { recursive: true, force: true }))).catch(() => undefined);
  await cleanup();
  try {
    let kitDir: string;
    try {
      kitDir = mountable(deps.kitDir);
      await realDir(kitDir, "kit");
      await mkdir(publicDir, { recursive: true, mode: 0o755 });
      await chmod(inDir, 0o755);
      await chmod(publicDir, 0o755);
      await mkdir(outDir, { mode: 0o700 });
      await chmod(outDir, 0o777); // the container runs as uid 10001; this folder holds nothing else
      await writeFile(path.join(inDir, "props.json"), JSON.stringify(input.props), { mode: 0o644, flag: "wx" });
      await writeFile(path.join(inDir, "meta.json"), JSON.stringify({ orientation: input.orientation, stills }), { mode: 0o644, flag: "wx" });
    } catch (e) {
      return failure(`The render folders could not be prepared (${e instanceof Error ? e.message : "unknown"}).`);
    }
    const staged = await stagePublicAssets(publicDir, input.assets ?? {}, OM_EXT);
    if (staged) return failure(staged);
    try {
      await realDir(inDir, "input");
      await realDir(outDir, "output");
    } catch (e) {
      return failure(e instanceof Error ? e.message : "The render folders are not usable.");
    }

    const host = await (deps.hostLimits ?? daemonLimits)();
    const image = deps.image ? await deps.image() : { ref: RENDER_IMAGE, pinned: false };
    if (!image.pinned) ctx.log(`render: image not pinned (could not resolve its id); running the tag ${image.ref}`);
    const mode = input.stills ? "om-stills" : "om-video";
    const name = `${NAME_PREFIX}${ctx.claim.stageRunId.replace(/[^a-zA-Z0-9_.-]/g, "").slice(0, 36)}-om-${randomBytes(4).toString("hex")}`;
    let plan;
    try {
      plan = tsxRenderPlan({ name, host, imageRef: image.ref, workerId: deps.workerId, inDir, outDir, kitDir, config: ctx.config.render, mode });
    } catch {
      return failure("The render settings are not usable for an OpenMontage render.");
    }
    const { r, tail } = await runRenderContainer(deps, ctx, { name, args: plan.args, timeoutMs: plan.timeoutMs, maxOutputBytes: plan.maxOutputBytes });
    if (r.aborted) throw aborted();
    if (r.timedOut) return failure(`The OpenMontage render took longer than its ${Math.round(plan.timeoutMs / 1000)} s limit and was stopped.`);
    if (r.truncated) return failure("The OpenMontage render printed too much output and was stopped.");
    if (r.code !== 0) return failure(`The OpenMontage render failed (exit ${r.code ?? r.signal}).`, tail.filter((l) => !/^\s*(>|\||\d+\s*\|)/.test(l)).slice(-4));

    if (input.stills) {
      const names: string[] = [];
      try {
        for (const f of stills) {
          const n = `om-frame-${f}.png`;
          await rm(path.join(ctx.attemptDir, n), { force: true });
          await copyRegular(path.join(outDir, `still-${f}.png`), path.join(ctx.attemptDir, n), MAX_STILL_BYTES);
          names.push(n);
        }
      } catch {
        return failure("The preview frames were not drawn.");
      }
      return { ok: true, outPath: "", stills: names, image: image.ref };
    }
    const outPath = path.join(ctx.attemptDir, input.outFile);
    await rm(outPath, { force: true });
    try {
      await copyRegular(path.join(outDir, "out.mp4"), outPath, TSX_SANDBOX.maxFileBytes);
    } catch (e) {
      return failure(e instanceof Error && /bigger than/.test(e.message) ? "The rendered video is too big." : "The render finished but made no video file.");
    }
    let p;
    try {
      p = await deps.probe(outPath, ctx.signal);
    } catch {
      if (ctx.signal.aborted) throw aborted();
      return failure("The rendered file is not a readable video.");
    }
    if (p.width !== size.width || p.height !== size.height) return failure(`The render is ${p.width}x${p.height}, expected ${size.width}x${size.height}.`);
    if (Math.abs(p.durationS - frames / FPS) > 1) return failure(`The video is ${p.durationS.toFixed(1)} s, expected ${(frames / FPS).toFixed(1)} s.`);
    return { ok: true, outPath, stills: [], image: image.ref };
  } finally {
    await cleanup();
  }
}
