import type pg from "pg";
import { approvalReaders } from "./approval-readers";
import { recordAudit } from "./audit";
import { advanceVideo, createVideo, type EnqueueOnly } from "./pipeline";
import { latestContent } from "./videos";

export type DeriveResult = { ok: true; videoId: string } | { ok: false; message: string };

const TITLE_MAX = 200;

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
  const title = (i.title ?? "").trim().slice(0, TITLE_MAX) || src.topic.slice(0, TITLE_MAX);
  const v = await createVideo(db, {
    format: "short", kind: "scene_kit", language: src.language as never, topic: title, channelId: src.channel_id, style: src.style, captionStyle: src.caption_style,
    derive: { sourceId: i.sourceId, fromScene: i.fromScene, toScene: i.toScene },
  });
  await recordAudit(db, "video.derived_created", { videoId: v.id, sourceId: i.sourceId, fromScene: i.fromScene, toScene: i.toScene, sessionId });
  try {
    await advanceVideo(db, queue, v.id, approvalReaders);
  } catch {
    /* best effort: the worker's sweep starts it */
  }
  return { ok: true, videoId: v.id };
}
