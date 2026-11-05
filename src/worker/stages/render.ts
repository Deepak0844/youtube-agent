import { lstat } from "node:fs/promises";
import path from "node:path";
import { KnownFailure } from "@/server/core/paid-call";
import { approvedScript } from "@/server/db/stage-content";
import { validateScenes, type SceneDoc } from "@/shared/scene";
import { retimeScenes } from "@/shared/scene/retime";
import { retimeScale3d, validateScale3d, type Scale3dScene } from "@/shared/scale3d";
import { retimeScene3d, validateScene3d, type Scene3d } from "@/shared/scene3d";
import { wordCount } from "@/server/core/lang";
import { catalogModelResolver } from "@/server/core/scene3d-direct";
import type { Renderer } from "@/server/providers/renderer";
import { openRegular, promotedPath, type AttemptHandler } from "./attempt";
import { contentBody, loadVideo, SIZE, type StageDeps } from "./deps";
import { audioSeconds } from "./voice-audio";

const isFile = async (f: string) => (await lstat(f).catch(() => null))?.isFile() === true;
const MAX_SCENES_BYTES = 1024 * 1024;

/** Reads and validates scenes.json: a plain file (no symlink, no FIFO), at most 1 MB, valid scene JSON. */
export async function readScenesFile(file: string): Promise<SceneDoc> {
  let text: string;
  const fh = await openRegular(file).catch(() => {
    throw new KnownFailure("scenes.json is missing or not a plain file. Run the build step again.");
  });
  try {
    if ((await fh.stat()).size > MAX_SCENES_BYTES) throw new KnownFailure("scenes.json is too big (over 1 MB). Run the build step again.");
    text = await fh.readFile("utf8");
  } finally {
    await fh.close();
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new KnownFailure("scenes.json is not valid JSON. Run the build step again.");
  }
  const v = validateScenes(json);
  if (!v.ok) throw new KnownFailure(`scenes_invalid: ${v.errors.slice(0, 3).join("; ")}. Run the build step again.`.slice(0, 600));
  return v.doc;
}

/** A 3D scene is drawn in software (no graphics card in the container) and takes about 5 minutes; below this the render would be killed half way. */
export const SCALE3D_MIN_RENDER_TIMEOUT_S = 900;

/**
 * Which renderer draws a 3D video: the native Mac renderer only when render.native_3d is on AND its preflight says ready;
 * otherwise the container, exactly as before, with the reason logged. A native render that fails is NOT retried in the
 * container (the owner decides, by switching the setting off).
 */
async function scale3dRenderer(deps: StageDeps, ctx: Parameters<AttemptHandler>[0]): Promise<{ renderer: Renderer; native: boolean }> {
  const container = { renderer: deps.renderer, native: false };
  if (!ctx.config.render.native3d) return container;
  if (!deps.native) {
    ctx.log("render: native 3D rendering is switched on but this worker has no native renderer; using the Docker renderer");
    return container;
  }
  const ready = await deps.native.ready().catch(() => ({ ready: false, message: "The readiness check failed." }));
  if (!ready.ready) {
    ctx.log(`render: native 3D rendering is switched on but not available (${ready.message.slice(0, 300)}) Using the Docker renderer.`);
    return container;
  }
  if (ctx.config.render.nativeTimeoutS > ctx.config.timeoutStageS) ctx.log(`render: the native limit (${ctx.config.render.nativeTimeoutS} s) is longer than the stage limit (${ctx.config.timeoutStageS} s), which stops the render first`);
  return { renderer: deps.native.renderer, native: true };
}

/** Reads and validates scale3d.json (same file rules as scenes.json). */
export async function readScale3dFile(file: string): Promise<Scale3dScene> {
  const fh = await openRegular(file).catch(() => {
    throw new KnownFailure("scale3d.json is missing or not a plain file. Run the build step again.");
  });
  let json: unknown;
  try {
    if ((await fh.stat()).size > MAX_SCENES_BYTES) throw new KnownFailure("scale3d.json is too big (over 1 MB). Run the build step again.");
    json = JSON.parse(await fh.readFile("utf8"));
  } catch (e) {
    if (e instanceof KnownFailure) throw e;
    throw new KnownFailure("scale3d.json is not valid JSON. Run the build step again.");
  } finally {
    await fh.close();
  }
  const v = validateScale3d(json);
  if (!v.ok) throw new KnownFailure(`scale3d_invalid: ${v.errors.slice(0, 3).join("; ")}. Run the build step again.`.slice(0, 600));
  return v.scene;
}

/**
 * Render: the renderer turns the scenes into render.mp4. It reads only promoted files and writes only into its attempt
 * folder. A slot in the render semaphore is taken by the dispatcher (handlers.ts), not here.
 *
 * The scenes come from Build's scenes.json and are validated again here, before any render time is spent. When there is no
 * scenes.json (Build ran without a scene model: the dry run and its tests) the old stub scene.json is passed with no `doc`;
 * only the fake renderer accepts that, the container renderer refuses a call without a validated doc.
 */
export function renderAttempt(deps: StageDeps): AttemptHandler {
  return async (ctx) => {
    const video = await loadVideo(deps.db, ctx);
    const scene3dRenderer = video.kind === "scene3d" ? await nativeOnly(deps, ctx) : null; // refuses at once, before any other work, when native is off or not ready
    const scale3d = video.kind === "scale3d" ? await scale3dRenderer(deps, ctx) : null;
    // The 900 s minimum is about the container's software drawing; the native Mac render has its own limit (render.native_timeout_s).
    if (scale3d && !scale3d.native && ctx.config.render.timeoutS < SCALE3D_MIN_RENDER_TIMEOUT_S) {
      throw new KnownFailure(
        `Raise render.timeout_s ("Render time limit, seconds") in Settings to at least ${SCALE3D_MIN_RENDER_TIMEOUT_S}: a 3D scale video needs about 5 minutes to render and the limit is ${ctx.config.render.timeoutS} s, so it would be stopped half way. Nothing was rendered.`,
      );
    }
    const narration = await contentBody<{ file?: unknown }>(deps.db, video.id, "narration");
    if (typeof narration.file !== "string") throw new KnownFailure("The narration record has no audio file. Run the voice step again.");
    const audioFile = await promotedPath(deps.root, video.id, narration.file);
    if (!(await isFile(audioFile))) throw new KnownFailure(`The file ${narration.file} from an earlier stage is missing. Run that stage again.`);

    if (scene3dRenderer) return renderScene3d(scene3dRenderer, deps, ctx, video, audioFile);
    if (video.kind === "scale3d") return renderScale3d(scale3d!.renderer, deps, ctx, video, audioFile);

    const scenesFile = await promotedPath(deps.root, video.id, "scenes.json");
    let sceneFile = scenesFile;
    let doc: SceneDoc | undefined;
    if (await isFile(scenesFile)) {
      doc = await readScenesFile(scenesFile);
    } else {
      sceneFile = await promotedPath(deps.root, video.id, "scene.json"); // fake/dry-run only, see above
      if (!(await isFile(sceneFile))) throw new KnownFailure("The file scenes.json from an earlier stage is missing. Run that stage again.");
    }
    const captions = await contentBody<{ words?: unknown }>(deps.db, video.id, "captions").catch(() => null);
    const total = (d: SceneDoc) => d.scenes.reduce((a, x) => a + x.durationMs, 0);
    let retime: { retimed: boolean; fromMs: number | null; toMs: number | null } = { retimed: false, fromMs: null, toMs: null };
    if (doc) {
      // Render-time only: the stored scenes stay as Build made them. Any problem keeps the original timing.
      const fromMs = total(doc);
      try {
        const words = (Array.isArray(captions?.words) ? captions.words : []).filter(
          (w): w is { startS: number; endS: number } => typeof (w as { startS?: unknown })?.startS === "number" && typeof (w as { endS?: unknown })?.endS === "number",
        );
        if (words.length === 0) throw new Error("no word times");
        const script = await approvedScript(deps.db, video.id);
        const beats = script.ok
          ? script.beats.map((b, i) => ({ id: typeof b?.id === "string" && b.id !== "" ? b.id : `beat-${i + 1}`, text: typeof (b as { text?: unknown })?.text === "string" ? (b as { text: string }).text : "" }))
          : [];
        const lastEnd = Math.max(...words.map((w) => w.endS)) + 0.3;
        const durationS = await audioSeconds(deps.mix, ctx, audioFile).catch(() => lastEnd);
        const res = retimeScenes(doc, { words, beats, narrationDurationS: durationS });
        if (!res.ok) throw new Error(res.errors.slice(0, 2).join("; "));
        doc = res.doc;
        retime = { retimed: true, fromMs, toMs: total(doc) };
      } catch (e) {
        ctx.log(`render: scenes not re-timed, original timing kept (${e instanceof Error ? e.message : "unknown"})`.slice(0, 300));
      }
    }
    const title = (await deps.db.query<{ topic: string }>("select topic from videos where id = $1", [video.id]).catch(() => null))?.rows[0]?.topic;
    const r = await deps.renderer.render(ctx, {
      sceneFile, doc, audioFile, videoId: video.id, title, style: video.style, captionStyle: video.captionStyle, captions: Array.isArray(captions?.words) ? captions.words : undefined, outFile: "render.mp4", size: SIZE,
    });
    if (path.dirname(path.resolve(r.outPath)) !== path.resolve(ctx.attemptDir)) throw new KnownFailure("The renderer wrote outside its attempt folder.");
    return { files: ["render.mp4"], result: { rendered: "render.mp4", scenes: doc ? doc.scenes.length : null, image: r.image ?? null, ...retime } };
  };
}

/** Render for a scale3d video: the checked description, re-timed to the real word times, through the same renderer and folder rules. */
async function renderScale3d(renderer: Renderer, deps: StageDeps, ctx: Parameters<AttemptHandler>[0], video: Awaited<ReturnType<typeof loadVideo>>, audioFile: string) {
  const sceneFile = await promotedPath(deps.root, video.id, "scale3d.json");
  let scene = await readScale3dFile(sceneFile);
  const captions = await contentBody<{ words?: unknown }>(deps.db, video.id, "captions").catch(() => null);
  const fromS = scene.beats.reduce((a, b) => a + b.duration_s, 0);
  let retime: { retimed: boolean; fromS: number | null; toS: number | null } = { retimed: false, fromS: null, toS: null };
  try {
    const words = (Array.isArray(captions?.words) ? captions.words : []).filter(
      (w): w is { startS: number; endS: number } => typeof (w as { startS?: unknown })?.startS === "number" && typeof (w as { endS?: unknown })?.endS === "number",
    );
    const lastEnd = words.length > 0 ? Math.max(...words.map((w) => w.endS)) + 0.3 : 0;
    const narrationDurationS = await audioSeconds(deps.mix, ctx, audioFile).catch(() => lastEnd);
    const res = retimeScale3d(scene, { words, narrationDurationS });
    if (!res.ok) throw new Error(res.reason);
    scene = res.scene;
    retime = { retimed: true, fromS, toS: res.totalS };
  } catch (e) {
    ctx.log(`render: 3D beats not re-timed, original timing kept (${e instanceof Error ? e.message : "unknown"})`.slice(0, 300));
  }
  const r = await renderer.render(ctx, {
    sceneFile, scale3d: scene, audioFile, videoId: video.id, style: video.style, captionStyle: video.captionStyle, captions: Array.isArray(captions?.words) ? captions.words : undefined, outFile: "render.mp4", size: SIZE,
  });
  if (path.dirname(path.resolve(r.outPath)) !== path.resolve(ctx.attemptDir)) throw new KnownFailure("The renderer wrote outside its attempt folder.");
  return { files: ["render.mp4"], result: { rendered: "render.mp4", kind: "scale3d", beats: scene.beats.length, image: r.image ?? null, ...retime } };
}

/**
 * The renderer for a scene3d video: the native Mac renderer ONLY. If render.native_3d is off, no native renderer is wired or the
 * preflight is not ready, the stage fails with a plain sentence; it never falls back to the container.
 */
async function nativeOnly(deps: StageDeps, ctx: Parameters<AttemptHandler>[0]): Promise<Renderer> {
  const hint = "Switch on render.native_3d (\"Render 3D videos natively on this Mac\") in System settings and run `npx remotion browser ensure` once in the project folder, then run Render again. Nothing was rendered.";
  if (!ctx.config.render.native3d) throw new KnownFailure(`3D scene videos are drawn on this Mac's GPU only, and render.native_3d is off. ${hint}`);
  if (!deps.native) throw new KnownFailure(`3D scene videos are drawn on this Mac's GPU only, and this worker has no native renderer. ${hint}`);
  const ready = await deps.native.ready().catch(() => ({ ready: false, message: "The readiness check failed." }));
  if (!ready.ready) throw new KnownFailure(`Native 3D rendering is not ready (${ready.message.slice(0, 250)}). ${hint}`);
  if (ctx.config.render.nativeTimeoutS > ctx.config.timeoutStageS) ctx.log(`render: the native limit (${ctx.config.render.nativeTimeoutS} s) is longer than the stage limit (${ctx.config.timeoutStageS} s), which stops the render first`);
  return deps.native.renderer;
}

/** Reads and validates scene3d.json (same file rules as scenes.json); every model must be a CC0 catalogue model. */
export async function readScene3dFile(file: string, resolver: ReturnType<typeof catalogModelResolver>): Promise<Scene3d> {
  const fh = await openRegular(file).catch(() => {
    throw new KnownFailure("scene3d.json is missing or not a plain file. Run the director step again.");
  });
  let json: unknown;
  try {
    if ((await fh.stat()).size > MAX_SCENES_BYTES) throw new KnownFailure("scene3d.json is too big (over 1 MB). Run the director step again.");
    json = JSON.parse(await fh.readFile("utf8"));
  } catch (e) {
    if (e instanceof KnownFailure) throw e;
    throw new KnownFailure("scene3d.json is not valid JSON. Run the director step again.");
  } finally {
    await fh.close();
  }
  const v = validateScene3d(json, resolver);
  if (!v.ok) throw new KnownFailure(`scene3d_invalid: ${v.errors.slice(0, 3).join("; ")}. Run the director step again.`.slice(0, 600));
  return v.scene;
}

/** Render for a scene3d video: the checked scene, re-timed to the real word times (shots follow the story lines), through the native renderer. */
async function renderScene3d(renderer: Renderer, deps: StageDeps, ctx: Parameters<AttemptHandler>[0], video: Awaited<ReturnType<typeof loadVideo>>, audioFile: string) {
  if (!deps.catalog3d) throw new KnownFailure("The 3D model catalogue is not wired, so the 3D scene cannot be checked.");
  const catalog = await deps.catalog3d().catch(() => {
    throw new KnownFailure("The 3D model catalogue could not be read (assets3d/manifest.json).");
  });
  const sceneFile = await promotedPath(deps.root, video.id, "scene3d.json");
  let scene = await readScene3dFile(sceneFile, catalogModelResolver(catalog));
  const captions = await contentBody<{ words?: unknown }>(deps.db, video.id, "captions").catch(() => null);
  const fromS = scene.shots.reduce((a, s) => a + s.duration_s, 0);
  let retime: { retimed: boolean; fromS: number | null; toS: number | null } = { retimed: false, fromS: null, toS: null };
  try {
    const words = (Array.isArray(captions?.words) ? captions.words : []).filter(
      (w): w is { startS: number; endS: number } => typeof (w as { startS?: unknown })?.startS === "number" && typeof (w as { endS?: unknown })?.endS === "number",
    );
    const lastEnd = words.length > 0 ? Math.max(...words.map((w) => w.endS)) + 0.3 : 0;
    const narrationDurationS = await audioSeconds(deps.mix, ctx, audioFile).catch(() => lastEnd);
    const script = await approvedScript(deps.db, video.id);
    const story = script.ok && Array.isArray(script.script.story) ? (script.script.story as Array<{ id?: unknown; line?: unknown }>) : [];
    const fromStory = story.filter((b) => typeof b?.id === "string" && typeof b?.line === "string").map((b) => ({ id: b.id as string, words: wordCount(b.line as string) }));
    // No story in the script (should not happen for this kind): each shot is its own beat, weighted by its planned length.
    const beats = fromStory.length > 0 ? fromStory : scene.shots.map((s) => ({ id: s.id, words: s.duration_s }));
    const res = retimeScene3d(scene, { beats, words, narrationDurationS });
    if (!res.ok) throw new Error(res.reason);
    scene = res.scene;
    retime = { retimed: true, fromS, toS: res.totalS };
  } catch (e) {
    ctx.log(`render: 3D shots not re-timed, original timing kept (${e instanceof Error ? e.message : "unknown"})`.slice(0, 300));
  }
  const r = await renderer.render(ctx, { sceneFile, scene3d: scene, audioFile, videoId: video.id, style: video.style, captionStyle: video.captionStyle, captions: Array.isArray(captions?.words) ? captions.words : undefined, outFile: "render.mp4", size: SIZE });
  if (path.dirname(path.resolve(r.outPath)) !== path.resolve(ctx.attemptDir)) throw new KnownFailure("The renderer wrote outside its attempt folder.");
  return { files: ["render.mp4"], result: { rendered: "render.mp4", kind: "scene3d", shots: scene.shots.length, image: r.image ?? null, ...retime } };
}
