import type pg from "pg";
import { chapterClips, sceneBounds, type ChapterClip } from "@/server/core/derive-view";
import { validateScenes } from "@/shared/scene";
import { retimeScenes } from "@/shared/scene/retime";
import type { EnqueueOnly } from "./pipeline";
import { approvedOutline, approvedScript } from "./stage-content";
import { latestContent } from "./videos";

export type DeriveResult = { ok: true; videoId: string } | { ok: false; message: string };

/**
 * The owner makes a short from a run of scenes of a LONG video (zero-based, inclusive). This only creates the new short (language, channel and look
 * come from the long video) and starts its route: the free `derive` step cuts the clip, then the owner approves the script like for any short.
 * Nothing is paid and nothing is approved or published here. Whether the run is a usable length is checked by the `derive` step against the
 * real narration times, which exist only after the long video has been narrated; it fails there with a plain sentence.
 */
export async function createDerivedShort(db: pg.Pool, queue: EnqueueOnly, i: { sourceId: string; fromScene: number; toScene: number; title?: string }, sessionId?: string): Promise<DeriveResult> {
  if (!Number.isInteger(i.fromScene) || !Number.isInteger(i.toScene) || i.fromScene < 0 || i.toScene < i.fromScene) return { ok: false, message: "Pick a first and a last scene, the first not after the last." };
  let src: { format: string; status: string; language: string; topic: string; channel_id: string | null; style: string | null; caption_style: string | null } | undefined;
  try {
    src = (await db.query("select format, status, language, topic, channel_id, style, caption_style from videos where id = $1", [i.sourceId])).rows[0];
  } catch {
    src = undefined; // not a uuid
  }
  if (!src) return { ok: false, message: "That video was not found." };
  if (src.format !== "long") return { ok: false, message: "Shorts can only be made from a long video." };
  if (src.status === "cancelled") return { ok: false, message: "That video was cancelled." };
  const scenes = (await latestContent(db, i.sourceId, "scenes"))?.body as { scenes?: unknown } | null | undefined;
  const count = Array.isArray(scenes?.scenes) ? scenes.scenes.length : 0;
  if (count === 0) return { ok: false, message: "The long video has no scenes yet. Let it finish building first." };
  if (i.toScene >= count) return { ok: false, message: `The long video has ${count} scenes; pick scenes 1 to ${count}.` };
  const dup = await db.query("select 1 from videos where derived_from = $1 and derive_from_scene = $2 and derive_to_scene = $3 and status <> 'cancelled'", [i.sourceId, i.fromScene, i.toScene]);
  if (dup.rowCount) return { ok: false, message: "A short from these scenes already exists." };
  // A clip was a scene-kit short, and the scene kit is removed: nothing is created.
  void queue; void sessionId;
  return { ok: false, message: "Clips from a long video are not available right now (they were made with the Scene kit, which is removed)." };
}

export interface DeriveTab {
  /** why the panel cannot offer scenes yet (the long video is not narrated, its script is not approved, ...), else null */
  notReady: string | null;
  /** [start, end] in ms of every scene on the real timeline (the same re-timing the derive step does), for the live length */
  bounds: Array<[number, number]>;
  /** the chapters of the approved outline that can be a clip */
  chapters: ChapterClip[];
  /** shorts already made from this video */
  shorts: Array<{ id: string; title: string; status: string; firstScene: number; lastScene: number }>;
}

/**
 * What the "Shorts from this video" panel needs. The clip lengths come from the long video's scenes re-timed to its stored caption times (the narration
 * length is taken as the last word plus 0.3 s, as Render does when it cannot probe the file), so they match what the derive step will cut to within a
 * fraction of a second; the derive step itself checks the real file.
 */
export async function loadDeriveTab(db: pg.Pool, videoId: string): Promise<DeriveTab> {
  const shortsQ = await db.query<{ id: string; topic: string; status: string; derive_from_scene: number; derive_to_scene: number }>(
    "select id, topic, status, derive_from_scene, derive_to_scene from videos where derived_from = $1 order by created_at desc, id limit 50", [videoId]);
  const shorts = shortsQ.rows.map((r) => ({ id: r.id, title: r.topic, status: r.status, firstScene: r.derive_from_scene + 1, lastScene: r.derive_to_scene + 1 }));
  const none = (notReady: string): DeriveTab => ({ notReady, bounds: [], chapters: [], shorts });

  const script = await approvedScript(db, videoId);
  if (!script.ok) return none("Approve this video's script first: a short is cut from the approved script.");
  const v = validateScenes((await latestContent(db, videoId, "scenes"))?.body, { long: true });
  if (!v.ok) return none("This video has no scenes yet. Let it finish building first.");
  const captions = (await latestContent(db, videoId, "captions"))?.body as { words?: unknown } | null | undefined;
  const words = (Array.isArray(captions?.words) ? captions.words : []).filter((w): w is { startS: number; endS: number } => Number.isFinite((w as { startS?: unknown })?.startS) && Number.isFinite((w as { endS?: unknown })?.endS));
  if (words.length === 0) return none("This video has no narration times yet. Let it finish narrating first.");
  const beats = script.beats.map((b, i) => ({ id: typeof b?.id === "string" && b.id !== "" ? b.id : `beat-${i + 1}`, text: typeof (b as { text?: unknown })?.text === "string" ? (b as { text: string }).text : "" }));
  const timed = retimeScenes(v.doc, { words, beats, narrationDurationS: Math.max(...words.map((w) => w.endS)) + 0.3, long: true });
  if (!timed.ok) return none("The scene times of this video could not be worked out. Render it again first.");
  const outline = await approvedOutline(db, videoId);
  return { notReady: null, bounds: sceneBounds(timed.doc.scenes), chapters: outline.ok ? chapterClips(timed.doc.scenes, outline.outline.chapters.map((c) => c.title)) : [], shorts };
}
