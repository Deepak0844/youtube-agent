import type pg from "pg";
import { characterProblem } from "@/server/core/character";
import { recordAudit } from "@/server/db/audit";

type Db = pg.Pool | pg.PoolClient;

export class CharacterRefused extends Error {}

export interface VideoCharacter {
  assetId: string;
  storageRef: string;
}

/** The video's live character picture, or null (none chosen, or the picture is gone or no longer valid). */
export async function characterOf(db: Db, videoId: string): Promise<VideoCharacter | null> {
  const { rows } = await db.query<{ id: string; storage_ref: string; kind: string; mime: string; width: number | null; height: number | null; deleted_at: Date | null }>(
    `select a.id, a.storage_ref, a.kind, a.mime, a.width, a.height, a.deleted_at from video_characters c join assets a on a.id = c.asset_id where c.video_id = $1`,
    [videoId],
  );
  const a = rows[0];
  if (!a || characterProblem({ kind: a.kind, mime: a.mime, width: a.width, height: a.height, deleted: a.deleted_at !== null }) !== null) return null;
  return { assetId: a.id, storageRef: a.storage_ref };
}

/** Sets (or clears, with null) the character of an AI video. Only AI videos have one. One audit row. */
export async function setVideoCharacter(db: pg.Pool, videoId: string, assetId: string | null): Promise<void> {
  const v = await db.query<{ kind: string }>("select kind from videos where id = $1", [videoId]);
  if (!v.rows[0]) throw new CharacterRefused("That video does not exist.");
  if (v.rows[0].kind !== "ai") throw new CharacterRefused("Only an AI video has a character.");
  if (assetId !== null) {
    const a = await db.query<{ kind: string; mime: string; width: number | null; height: number | null; deleted_at: Date | null }>("select kind, mime, width, height, deleted_at from assets where id = $1", [assetId]);
    const row = a.rows[0];
    if (!row) throw new CharacterRefused("That picture does not exist.");
    const why = characterProblem({ kind: row.kind, mime: row.mime, width: row.width, height: row.height, deleted: row.deleted_at !== null });
    if (why) throw new CharacterRefused(why);
  }
  const client = await db.connect();
  try {
    await client.query("begin");
    await client.query("insert into video_characters (video_id, asset_id) values ($1, $2) on conflict (video_id) do update set asset_id = excluded.asset_id", [videoId, assetId]);
    await recordAudit(client, "video.character_set", { video: videoId, asset: assetId });
    await client.query("commit");
  } catch (e) {
    await client.query("rollback").catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
}
