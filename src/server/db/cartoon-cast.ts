import type pg from "pg";
import { parseCast } from "@/server/core/cartoon-cast";
import type { ToonCharacter } from "../../../remotion/kit/toon/context";

// The cast of a cartoon series and the copy each of its videos keeps. The cast is validated on the way in AND out (parseCast): a bad stored value reads as no cast.

const read = (v: unknown): ToonCharacter[] | null => {
  if (v === null || v === undefined) return null;
  const r = parseCast(v);
  return r.ok ? r.cast : null;
};

/** The cast this video was started with (its snapshot), or null. */
export async function getVideoCast(db: pg.Pool, videoId: string): Promise<ToonCharacter[] | null> {
  const r = await db.query<{ cast_snapshot: unknown }>("select cast_snapshot from videos where id = $1", [videoId]);
  return read(r.rows[0]?.cast_snapshot);
}

/** The series a video belongs to (null for a video that is not part of a series). */
export async function videoSeriesId(db: pg.Pool, videoId: string): Promise<string | null> {
  return (await db.query<{ series_id: string | null }>("select series_id from videos where id = $1", [videoId])).rows[0]?.series_id ?? null;
}

export async function setVideoCast(db: pg.Pool, videoId: string, cast: ToonCharacter[]): Promise<void> {
  await db.query("update videos set cast_snapshot = $2::jsonb where id = $1", [videoId, JSON.stringify(cast)]);
}

export async function getSeriesCast(db: pg.Pool, seriesId: string): Promise<ToonCharacter[] | null> {
  const r = await db.query<{ cast: unknown }>("select settings->'cartoon'->'cast' as cast from series where id = $1", [seriesId]);
  return read(r.rows[0]?.cast);
}

/** Saves the series cast, but only when the series has none yet: the first episode to finish makes the cast and every later one keeps it. Returns whether it saved. */
export async function saveSeriesCast(db: pg.Pool, seriesId: string, cast: ToonCharacter[]): Promise<boolean> {
  const r = await db.query(
    "update series set settings = jsonb_set(settings, '{cartoon}', jsonb_build_object('cast', $2::jsonb), true) where id = $1 and settings->'cartoon'->'cast' is null",
    [seriesId, JSON.stringify(cast)],
  );
  return (r.rowCount ?? 0) > 0;
}

/** Clears the series cast: the next NEW episode makes a new one. Episodes already started keep their snapshot. */
export async function clearSeriesCast(db: pg.Pool, seriesId: string): Promise<void> {
  await db.query("update series set settings = settings - 'cartoon' where id = $1", [seriesId]);
}
