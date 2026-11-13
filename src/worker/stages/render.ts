import { copyFile, lstat, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { KnownFailure } from "@/server/core/paid-call";
import { canonicalJson, sha256Hex } from "@/server/core/content-hash";
import { approvedOutline, approvedScript } from "@/server/db/stage-content";
import { chapterFrameChunks, chapterMarks, chapterMarksFromScenes, outlineTotalS, type FrameChunk } from "@/server/core/long-form";
import { validateScenes, type SceneDoc } from "@/shared/scene";
import { retimeScenes } from "@/shared/scene/retime";
import type { RenderArgs, Renderer } from "@/server/providers/renderer";
import { MAX_VIDEO_BYTES } from "@/server/providers/renderer/remotion-container";
import { joinClips, type MixDeps } from "@/server/render/mix";
import { openRegular, promotedPath, type AttemptHandler } from "./attempt";
import { videoPath } from "@/server/storage/paths";
import { contentBody, LANDSCAPE_SIZE, loadVideo, SIZE, type StageDeps } from "./deps";
import { audioSeconds } from "./voice-audio";

const isFile = async (f: string) => (await lstat(f).catch(() => null))?.isFile() === true;
const MAX_SCENES_BYTES = 1024 * 1024;
const FPS = 30; // equal to remotion/kit/theme.ts

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
    const narration = await contentBody<{ file?: unknown }>(deps.db, video.id, "narration");
    if (typeof narration.file !== "string") throw new KnownFailure("The narration record has no audio file. Run the voice step again.");
    const audioFile = await promotedPath(deps.root, video.id, narration.file);
    if (!(await isFile(audioFile))) throw new KnownFailure(`The file ${narration.file} from an earlier stage is missing. Run that stage again.`);


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
        // A long video drawn on Build's rough timing would drift away from 10+ minutes of real narration and the chapter cards would land wrong: stop, do not guess.
        if (long) throw new KnownFailure(`retime_failed: ${e instanceof Error ? e.message : "unknown"}. The scenes could not be fitted to the narration. Nothing was rendered.`.slice(0, 600));
        ctx.log(`render: scenes not re-timed, original timing kept (${e instanceof Error ? e.message : "unknown"})`.slice(0, 300));
      }
    }
    const title = (await deps.db.query<{ topic: string }>("select topic from videos where id = $1", [video.id]).catch(() => null))?.rows[0]?.topic;
    // Chapter cards start where each chapter's first scene starts (beat ids c1_..., c2_...); without scenes or ids, at their share of the outline's seconds.
    const chapterInfo = outline?.ok ? (doc ? chapterMarksFromScenes(outline.outline, doc.scenes, total(doc)) : { marks: chapterMarks(outline.outline, outlineTotalS(outline.outline.chapters) * 1000), from: "estimate" as const }) : null;
    const landscape = chapterInfo ? { layout: "landscape" as const, chapters: chapterInfo.marks } : null;
    const args: RenderArgs = {
      sceneFile, doc, audioFile, videoId: video.id, title, style: video.style, captionStyle: video.captionStyle, captions: Array.isArray(captions?.words) ? captions.words : undefined, outFile: "render.mp4", size: landscape ? LANDSCAPE_SIZE : SIZE, ...(landscape ?? {}),
    };
    // A long video with two or more chapters is drawn one chapter at a time (each its own container run with its own time limit and memory) and joined.
    const chunks = landscape && doc && deps.mix ? chapterFrameChunks(landscape.chapters, FPS) : [];
    let image: string | undefined;
    let chaptersRendered = 0;
    let chaptersReused = 0;
    if (chunks.length > 1 && deps.mix && doc) {
      const res = await renderInChapters(deps.renderer, deps.mix, ctx, args, chunks, Math.max(...doc.scenes.map((x) => x.startMs + x.durationMs)) / 1000, videoPath(deps.root, video.id, "chapter-cache"));
      image = res.image;
      chaptersRendered = res.chunks;
      chaptersReused = res.reused ?? 0;
    } else {
      const r = await deps.renderer.render(ctx, args);
      if (path.dirname(path.resolve(r.outPath)) !== path.resolve(ctx.attemptDir)) throw new KnownFailure("The renderer wrote outside its attempt folder.");
      image = r.image;
    }
    return { files: ["render.mp4"], result: { rendered: "render.mp4", scenes: doc ? doc.scenes.length : null, image: image ?? null, ...retime, ...(chaptersRendered > 0 ? { chunks: chaptersRendered } : {}), ...(chaptersReused > 0 ? { chunksReused: chaptersReused } : {}), ...(chapterInfo ? { chapters: chapterInfo.marks, chaptersFrom: chapterInfo.from, totalMs: doc ? total(doc) : null } : {}) } };
  };
}

/**
 * Draws a long video one chapter at a time and joins the clips into render.mp4 (no sound: the voice step lays the narration on). Each chapter is its own
 * renderer call, so each gets the full time limit and memory. The clips are removed from the attempt folder whether it worked or not. A joined length
 * more than 2 s away from the scenes (a chapter missing or drawn twice) fails the stage and keeps nothing.
 *
 * `cacheDir` (optional): every finished chapter is also kept there, named by a hash of everything that shapes it (scenes, captions, look, size, frame
 * range). A later attempt copies a matching clip back instead of drawing it again, so a failure in chapter 5 does not redraw chapters 1-4. A reused clip
 * drawn by another render image than this attempt's fresh chapters is drawn again (one video, one image). The cache is removed once the video is joined.
 */
export async function renderInChapters(renderer: Renderer, mix: MixDeps, ctx: Parameters<AttemptHandler>[0], args: RenderArgs, chunks: readonly FrameChunk[], expectedS: number, cacheDir?: string): Promise<{ chunks: number; image?: string; reused?: number }> {
  const nameOf = (i: number) => `chapter-${String(i + 1).padStart(2, "0")}.mp4`;
  // File names and paths do not change the picture; everything else in args does.
  const keyOf = (chunk: FrameChunk) => sha256Hex(canonicalJson({ ...args, outFile: null, sceneFile: null, audioFile: null, chunk }));
  const clips: string[] = [];
  const images: Array<string | undefined> = [];
  const reused = new Set<number>();
  const draw = async (i: number, chunk: FrameChunk) => {
    const r = await renderer.render(ctx, { ...args, outFile: nameOf(i), chunk });
    if (path.dirname(path.resolve(r.outPath)) !== path.resolve(ctx.attemptDir)) throw new KnownFailure("The renderer wrote outside its attempt folder.");
    images[i] = r.image;
    reused.delete(i);
    if (cacheDir) await keep(cacheDir, keyOf(chunk), path.join(ctx.attemptDir, nameOf(i)), r.image).catch(() => ctx.log(`render: chapter ${i + 1} could not be kept for a retry`));
  };
  try {
    for (const [i, chunk] of chunks.entries()) {
      const hit = cacheDir ? await cached(cacheDir, keyOf(chunk)) : null;
      if (hit) {
        await copyFile(hit.file, path.join(ctx.attemptDir, nameOf(i)));
        images[i] = hit.image;
        reused.add(i);
        ctx.log(`render: chapter ${i + 1} of ${chunks.length} reused from an earlier attempt`);
      } else {
        ctx.log(`render: chapter ${i + 1} of ${chunks.length}`);
        await draw(i, chunk);
      }
      clips.push(nameOf(i));
    }
    const fresh = images.find((im, i) => !reused.has(i) && im !== undefined);
    for (const i of [...reused]) {
      if (fresh === undefined || images[i] === fresh) continue;
      ctx.log(`render: chapter ${i + 1} was drawn by another render image, drawing it again`);
      await draw(i, chunks[i]!);
    }
    const image = fresh ?? images.find((im) => im !== undefined);
    const outFile = path.join(ctx.attemptDir, "render.mp4");
    const joinedS = await joinClips(mix, ctx, { clips, out: outFile });
    if ((await stat(outFile)).size > MAX_VIDEO_BYTES) {
      await rm(outFile, { force: true }).catch(() => undefined);
      throw new KnownFailure("The joined video is too big.");
    }
    if (Math.abs(joinedS - expectedS) > 2) {
      await rm(path.join(ctx.attemptDir, "render.mp4"), { force: true }).catch(() => undefined);
      // A clip in the cache may be the wrong one: drop it all so the next attempt draws every chapter.
      if (cacheDir) await rm(cacheDir, { recursive: true, force: true }).catch(() => undefined);
      throw new KnownFailure(`The joined video is ${joinedS.toFixed(1)} s but the scenes add up to ${expectedS.toFixed(1)} s. Nothing was kept.`);
    }
    if (cacheDir) await rm(cacheDir, { recursive: true, force: true }).catch(() => undefined);
    return { chunks: clips.length, ...(image ? { image } : {}), ...(reused.size ? { reused: reused.size } : {}) };
  } finally {
    await Promise.all([...chunks.keys()].map((i) => rm(path.join(ctx.attemptDir, nameOf(i)), { force: true }))).catch(() => undefined);
    await rm(path.join(ctx.attemptDir, "chapters.txt"), { force: true }).catch(() => undefined);
  }
}

const KEY = /^[0-9a-f]{64}$/;
/** Copies a finished clip into the cache (temp name, then rename, so a half-written clip is never found). */
async function keep(dir: string, key: string, clip: string, image: string | undefined): Promise<void> {
  if (!KEY.test(key)) return;
  await mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `${key}.mp4.tmp`);
  await copyFile(clip, tmp);
  await writeFile(path.join(dir, `${key}.json`), JSON.stringify({ image: image ?? null }));
  await rename(tmp, path.join(dir, `${key}.mp4`));
}

/** A kept clip for this key, or null. Only a regular, non-empty file counts. */
async function cached(dir: string, key: string): Promise<{ file: string; image: string | undefined } | null> {
  if (!KEY.test(key)) return null;
  const file = path.join(dir, `${key}.mp4`);
  try {
    const st = await lstat(file);
    if (!st.isFile() || st.size === 0) return null;
    const meta = JSON.parse(await readFile(path.join(dir, `${key}.json`), "utf8")) as { image?: unknown };
    return { file, image: typeof meta.image === "string" ? meta.image : undefined };
  } catch {
    return null;
  }
}
