import { randomUUID } from "node:crypto";
import type pg from "pg";

// The owner's notes on a cartoon scene (scene_notes). The build reads the oldest unused note once. Plain sentences come back for every refusal.

export const SCENE_NOTE_MAX = 500;
export const SCENE_NOTES_PER_VIDEO = 3;

export async function addSceneNote(db: pg.Pool, videoId: string, raw: string): Promise<{ ok: true; id: string } | { ok: false; message: string }> {
  const note = raw.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim();
  if (note.length === 0) return { ok: false, message: "Write the note, or send the scene back without one." };
  if (note.length > SCENE_NOTE_MAX) return { ok: false, message: `Keep the note to ${SCENE_NOTE_MAX} characters or fewer.` };
  const id = randomUUID();
  // One statement: the count and the insert together, so two clicks cannot make a 4th note.
  const r = await db.query(
    `insert into scene_notes (id, video_id, note) select $1, $2, $3 where (select count(*) from scene_notes where video_id = $2) < ${SCENE_NOTES_PER_VIDEO}`,
    [id, videoId, note],
  );
  if ((r.rowCount ?? 0) === 0) return { ok: false, message: `This video already had ${SCENE_NOTES_PER_VIDEO} notes. Start a fresh scene instead.` };
  return { ok: true, id };
}

export async function deleteSceneNote(db: pg.Pool, id: string): Promise<void> {
  await db.query("delete from scene_notes where id = $1 and used_at is null", [id]);
}

/** The oldest note the build has not used yet, or null. */
export async function unusedSceneNote(db: pg.Pool, videoId: string): Promise<{ id: string; note: string } | null> {
  const r = await db.query<{ id: string; note: string }>("select id, note from scene_notes where video_id = $1 and used_at is null order by created_at limit 1", [videoId]);
  return r.rows[0] ?? null;
}

export async function markSceneNoteUsed(db: pg.Pool, id: string): Promise<void> {
  await db.query("update scene_notes set used_at = now() where id = $1 and used_at is null", [id]);
}
