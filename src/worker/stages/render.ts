import { lstat } from "node:fs/promises";
import path from "node:path";
import { KnownFailure } from "@/server/core/paid-call";
import { approvedScript } from "@/server/db/stage-content";
import { validateScenes, type SceneDoc } from "@/shared/scene";
import { retimeScenes } from "@/shared/scene/retime";
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
    const r = await deps.renderer.render(ctx, {
      sceneFile, doc, audioFile, captions: Array.isArray(captions?.words) ? captions.words : undefined, outFile: "render.mp4", size: SIZE,
    });
    if (path.dirname(path.resolve(r.outPath)) !== path.resolve(ctx.attemptDir)) throw new KnownFailure("The renderer wrote outside its attempt folder.");
    return { files: ["render.mp4"], result: { rendered: "render.mp4", scenes: doc ? doc.scenes.length : null, image: r.image ?? null, ...retime } };
  };
}
