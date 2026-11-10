import type pg from "pg";
import { failingScenes } from "@/server/core/scene-repair";
import { assetRefs } from "@/server/core/scene-build";
import { getAsset } from "@/server/db/assets";
import { mediaSigner } from "@/server/db/queue-data";
import { approvedScript } from "@/server/db/stage-content";
import { latestContent } from "@/server/db/videos";
import { pickAudio, sceneRows, type PreviewData } from "@/shared/preview";
import { validateScenes, type SceneDoc } from "@/shared/scene";
import { retimeScenes } from "@/shared/scene/retime";

// What the Preview tab needs, read only: the built scenes (timed like Render times them), word times, signed URLs for
// pictures and sound, and the rule-check result per scene. Media paths never leave here; the page gets signed URLs.
const FPS = 30; // equal to remotion/kit/theme.ts and the render step

const asObj = (v: unknown): Record<string, unknown> => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

export async function loadPreview(db: pg.Pool, videoId: string): Promise<PreviewData | null> {
  const scenes = await latestContent(db, videoId, "scenes");
  if (!scenes) return null;
  const long = (await db.query<{ format: string }>("select format from videos where id = $1", [videoId])).rows[0]?.format === "long";
  const v = validateScenes(scenes.body, { long });
  const checks = v.ok ? { indexes: [] as number[], documentLevel: false } : failingScenes(v.errors);
  // Scenes that fail the checks may still be shown; the kit needs a doc shaped like a scene file, so use the stored one.
  let doc = (v.ok ? v.doc : scenes.body) as SceneDoc;
  if (!doc || !Array.isArray(doc.scenes) || doc.scenes.length === 0) return null;
  const sign = await mediaSigner(db);

  const capBody = asObj((await latestContent(db, videoId, "captions"))?.body);
  const words = (Array.isArray(capBody.words) ? capBody.words : []).filter(
    (w): w is { word: string; startS: number; endS: number; estimated?: boolean } => typeof w?.word === "string" && Number.isFinite(w.startS) && Number.isFinite(w.endS),
  );
  // Same re-timing Render does, so scene starts match the narration. Any problem keeps the stored timing.
  if (v.ok && words.length > 0) {
    try {
      const script = await approvedScript(db, videoId);
      const beats = script.ok ? script.beats.map((b, i) => ({ id: typeof b?.id === "string" && b.id !== "" ? b.id : `beat-${i + 1}`, text: typeof (b as { text?: unknown })?.text === "string" ? (b as { text: string }).text : "" })) : [];
      const r = retimeScenes(doc, { words, beats, narrationDurationS: Math.max(...words.map((w) => w.endS)) + 0.3, ...(long ? { long } : {}) });
      if (r.ok) doc = r.doc;
    } catch {
      /* keep stored timing */
    }
  }

  const assets: Record<string, string> = {};
  for (const id of new Set(assetRefs(doc))) {
    const a = await getAsset(db, id).catch(() => null);
    const url = a && !a.deletedAt && a.kind === "image" ? sign?.(a.storageRef) : null;
    if (url) assets[id] = url;
  }

  const narr = asObj((await latestContent(db, videoId, "narration"))?.body);
  const narrationSrc = typeof narr.file === "string" && /^[\w.-]+$/.test(narr.file) ? (sign?.(`videos/${videoId}/${narr.file}`) ?? null) : null;
  const video = await latestContent(db, videoId, "video");
  const mixSrc = video?.filePath && /(^|\/)final\.mp4$/.test(video.filePath) ? (sign?.(video.filePath) ?? null) : null;

  return {
    doc, fps: FPS, rows: sceneRows(doc, new Set(checks.indexes), FPS), documentProblems: checks.documentLevel ? 1 : 0,
    captions: words.length > 0 ? words : null, assets, audio: pickAudio({ mixSrc, narrationSrc }),
  };
}
