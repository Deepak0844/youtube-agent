import { lstat } from "node:fs/promises";
import path from "node:path";
import { KnownFailure } from "@/server/core/paid-call";
import { canonicalJson, sha256Hex } from "@/server/core/content-hash";
import { readPreviews } from "@/server/core/scene3d-stills";
import { approvalState, readSnapshot } from "@/server/db/approvals";
import { approvedOutline, approvedScript } from "@/server/db/stage-content";
import { chapterMarks, outlineTotalS } from "@/server/core/long-form";
import { validateScenes, type SceneDoc } from "@/shared/scene";
import { retimeScenes } from "@/shared/scene/retime";
import { retimeScale3d, validateScale3d, type Scale3dScene } from "@/shared/scale3d";
import { retimeScene3d, validateScene3d, type Scene3d } from "@/shared/scene3d";
import { wordCount } from "@/server/core/lang";
import { catalogModelResolver } from "@/server/core/scene3d-direct";
import { readSceneCodeBody, sceneCodeSha, type Scene3dCodeBody } from "@/server/core/scene3d-code-body";
import { isScene3dKind } from "@/server/core/pipeline-plan";
import { sha256Hex as sha256Text } from "@/server/core/content-hash";
import type { Renderer } from "@/server/providers/renderer";
import { openRegular, promotedPath, type AttemptHandler } from "./attempt";
import { contentBody, LANDSCAPE_SIZE, loadVideo, SIZE, type StageDeps } from "./deps";
import { audioSeconds } from "./voice-audio";

const isFile = async (f: string) => (await lstat(f).catch(() => null))?.isFile() === true;
const MAX_SCENES_BYTES = 1024 * 1024;

/** Reads and validates scenes.json: a plain file (no symlink, no FIFO), at most 1 MB, valid scene JSON. */
export async function readScenesFile(file: string, long = false): Promise<SceneDoc> {
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
  const v = validateScenes(json, { long });
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
    const scene3dRenderer = isScene3dKind(video.kind) ? await nativeOnly(deps, ctx) : null; // refuses at once, before any other work, when native is off or not ready
    const approvedSceneSha = isScene3dKind(video.kind) ? await approvedLookSceneSha(deps, video.id) : null; // and before the long render, unless the owner approved the look
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

    if (scene3dRenderer) return video.kind === "scene3d_code" ? renderScene3dCode(scene3dRenderer, deps, ctx, video, approvedSceneSha!) : renderScene3d(scene3dRenderer, deps, ctx, video, audioFile, approvedSceneSha!);
    if (video.kind === "scale3d") return renderScale3d(scale3d!.renderer, deps, ctx, video, audioFile);

    // A long video (scene kit only) is drawn in one pass on the landscape composition, with the chapter cards of the outline the owner approved.
    const long = video.format === "long";
    const outline = long ? await approvedOutline(deps.db, video.id) : null;
    if (outline && !outline.ok) throw new KnownFailure(`${outline.reason} Nothing was rendered.`);
    const scenesFile = await promotedPath(deps.root, video.id, "scenes.json");
    let sceneFile = scenesFile;
    let doc: SceneDoc | undefined;
    if (await isFile(scenesFile)) {
      doc = await readScenesFile(scenesFile, long);
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
        const res = retimeScenes(doc, { words, beats, narrationDurationS: durationS, ...(long ? { long } : {}) });
        if (!res.ok) throw new Error(res.errors.slice(0, 2).join("; "));
        doc = res.doc;
        retime = { retimed: true, fromMs, toMs: total(doc) };
      } catch (e) {
        ctx.log(`render: scenes not re-timed, original timing kept (${e instanceof Error ? e.message : "unknown"})`.slice(0, 300));
      }
    }
    const title = (await deps.db.query<{ topic: string }>("select topic from videos where id = $1", [video.id]).catch(() => null))?.rows[0]?.topic;
    const landscape = outline?.ok ? { layout: "landscape" as const, chapters: chapterMarks(outline.outline, doc ? total(doc) : outlineTotalS(outline.outline.chapters) * 1000) } : null;
    const r = await deps.renderer.render(ctx, {
      sceneFile, doc, audioFile, videoId: video.id, title, style: video.style, captionStyle: video.captionStyle, captions: Array.isArray(captions?.words) ? captions.words : undefined, outFile: "render.mp4", size: landscape ? LANDSCAPE_SIZE : SIZE, ...(landscape ?? {}),
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
export async function nativeOnly(deps: StageDeps, ctx: Parameters<AttemptHandler>[0], step = "Render"): Promise<NonNullable<StageDeps["native"]>["renderer"]> {
  // The stored error is cut at about 120 characters in places: the fix comes first, the detail after.
  const fix = 'Turn on render.native_3d in System settings and run "npx remotion browser ensure" first: 3D scene videos render on this Mac only.';
  const tail = `Run ${step} again afterwards. Nothing was rendered.`;
  if (!ctx.config.render.native3d) throw new KnownFailure(`${fix} The setting is off. ${tail}`);
  if (!deps.native) throw new KnownFailure(`${fix} This worker has no native renderer. ${tail}`);
  const ready = await deps.native.ready().catch(() => ({ ready: false, message: "The readiness check failed." }));
  if (!ready.ready) throw new KnownFailure(`${fix} Not ready: ${ready.message.slice(0, 250)} ${tail}`);
  if (ctx.config.render.nativeTimeoutS > ctx.config.timeoutStageS) ctx.log(`render: the native limit (${ctx.config.render.nativeTimeoutS} s) is longer than the stage limit (${ctx.config.timeoutStageS} s), which stops the render first`);
  return deps.native.renderer;
}

/** The scene fingerprint of the look the owner approved, or a plain refusal: a 3D story is never rendered before its look is approved (and still valid). */
async function approvedLookSceneSha(deps: StageDeps, videoId: string): Promise<string> {
  const refusal = new KnownFailure("Approve the look of the preview pictures first (Queue, Look gate). Nothing was rendered.");
  if (!(await approvalState(deps.db, videoId, "look")).approved) throw refusal;
  const snap = await readSnapshot(deps.db, videoId, "look");
  const previews = snap === "no_video" ? null : readPreviews(snap.inputs.content.previews?.body);
  if (!previews) throw refusal;
  return previews.scene_sha256;
}

/**
 * The stored AI-written scene of a scene3d_code video: the `scenes` body (source + props + fingerprints) AND the promoted file scene.tsx,
 * which must hold exactly the same source. Any difference, an unreadable body or a missing file is a plain refusal. The ONE copy: the preview
 * pictures and the full render both call it.
 */
export async function loadSceneCode(deps: StageDeps, video: Awaited<ReturnType<typeof loadVideo>>): Promise<Scene3dCodeBody> {
  const body = readSceneCodeBody(await contentBody<unknown>(deps.db, video.id, "scenes").catch(() => null));
  if (!body) throw new KnownFailure("The stored scene code is missing or damaged. Run the author step again. Nothing was rendered.");
  const file = await promotedPath(deps.root, video.id, "scene.tsx");
  const fh = await openRegular(file).catch(() => {
    throw new KnownFailure("The file scene.tsx from the author step is missing. Run that step again. Nothing was rendered.");
  });
  let onDisk: string;
  try {
    if ((await fh.stat()).size > 70 * 1024) throw new KnownFailure("The file scene.tsx is too big. Run the author step again. Nothing was rendered.");
    onDisk = await fh.readFile("utf8");
  } finally {
    await fh.close();
  }
  if (sha256Text(onDisk) !== body.source_sha256) throw new KnownFailure("The file scene.tsx is not the scene that was checked and saved (it was changed). Run the author step again. Nothing was rendered.");
  return body;
}

/** Render for a scene3d_code video: the approved source and props through the native renderer, which re-checks the source and the fingerprint before running anything. */
async function renderScene3dCode(renderer: Renderer, deps: StageDeps, ctx: Parameters<AttemptHandler>[0], video: Awaited<ReturnType<typeof loadVideo>>, approvedSceneSha: string) {
  const body = await loadSceneCode(deps, video);
  if (sceneCodeSha(body.source, body.props) !== approvedSceneSha) throw new KnownFailure("The scene is not the one you approved the look for. Run the preview pictures again and approve the new look. Nothing was rendered.");
  const narration = await contentBody<{ file?: unknown }>(deps.db, video.id, "narration");
  const audioFile = typeof narration.file === "string" ? await promotedPath(deps.root, video.id, narration.file) : null;
  if (!audioFile || !(await isFile(audioFile))) throw new KnownFailure("The narration audio from an earlier stage is missing. Run that stage again.");
  const captions = await contentBody<{ words?: unknown }>(deps.db, video.id, "captions").catch(() => null);
  const sceneFile = await promotedPath(deps.root, video.id, "scene.tsx");
  const r = await renderer.render(ctx, { sceneFile, scene3dCode: { source: body.source, props: body.props, expectedSha256: approvedSceneSha }, audioFile, videoId: video.id, style: video.style, captionStyle: video.captionStyle, captions: Array.isArray(captions?.words) ? captions.words : undefined, outFile: "render.mp4", size: SIZE });
  if (path.dirname(path.resolve(r.outPath)) !== path.resolve(ctx.attemptDir)) throw new KnownFailure("The renderer wrote outside its attempt folder.");
  return { files: ["render.mp4"], result: { rendered: "render.mp4", kind: "scene3d_code", beats: body.props.beats.length, durationS: body.props.durationS, image: r.image ?? null } };
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

/**
 * The checked scene of a scene3d video, re-timed to the real word times (shots follow the story lines). The ONE copy: the preview
 * pictures and the full render both call it, so the pictures the owner approves show exactly the scene that is rendered.
 */
export async function loadRetimedScene3d(deps: StageDeps, ctx: Parameters<AttemptHandler>[0], video: Awaited<ReturnType<typeof loadVideo>>, audioFile: string) {
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
  return { scene, sceneFile, captions, retime };
}

/** Render for a scene3d video: the checked, re-timed scene through the native renderer. */
async function renderScene3d(renderer: Renderer, deps: StageDeps, ctx: Parameters<AttemptHandler>[0], video: Awaited<ReturnType<typeof loadVideo>>, audioFile: string, approvedSceneSha: string) {
  const { scene, sceneFile, captions, retime } = await loadRetimedScene3d(deps, ctx, video, audioFile);
  // The look the owner approved shows exactly this scene; any difference (a new director run, a different retiming) needs new pictures first.
  if (sha256Hex(canonicalJson(scene)) !== approvedSceneSha) throw new KnownFailure("The scene is not the one you approved the look for. Run the preview pictures again and approve the new look. Nothing was rendered.");
  const r = await renderer.render(ctx, { sceneFile, scene3d: scene, audioFile, videoId: video.id, style: video.style, captionStyle: video.captionStyle, captions: Array.isArray(captions?.words) ? captions.words : undefined, outFile: "render.mp4", size: SIZE });
  if (path.dirname(path.resolve(r.outPath)) !== path.resolve(ctx.attemptDir)) throw new KnownFailure("The renderer wrote outside its attempt folder.");
  return { files: ["render.mp4"], result: { rendered: "render.mp4", kind: "scene3d", shots: scene.shots.length, image: r.image ?? null, ...retime } };
}
