import type pg from "pg";
import { parseCast } from "@/server/core/cartoon-cast";
import { KnownFailure } from "@/server/core/paid-call";
import { getVideoCast, saveSeriesCast, setVideoCast, videoSeriesId } from "@/server/db/cartoon-cast";
import type { ToonCharacter } from "../../../remotion/kit/toon/context";
import { readSceneFile } from "./engine-build";

// Cartoon videos in the code-scene step: which cast the build starts with, and what happens to the cast the engine makes on a series' first episode.

export interface CartoonCastState {
  /** The characters the scene must use (this video's snapshot), or null when there are none yet. */
  cast: ToonCharacter[] | null;
  /** The video is an episode of a series: its first episode makes the cast (cast.json) and the series keeps it. */
  series: boolean;
}

export async function loadCartoonCast(db: pg.Pool, videoId: string): Promise<CartoonCastState> {
  const [cast, seriesId] = await Promise.all([getVideoCast(db, videoId), videoSeriesId(db, videoId)]);
  return { cast, series: seriesId !== null };
}

/**
 * After a build of a series episode that started without a cast: the engine wrote cast.json. Check it (same rules as everything else that is
 * written by a model), keep it as this video's cast and, when the series still has none, as the series' cast. A missing or invalid file is a plain failure.
 */
export async function takeEngineCast(db: pg.Pool, videoId: string, workDir: string): Promise<ToonCharacter[]> {
  const text = await readSceneFile(workDir, "cast.json").catch(() => {
    throw new KnownFailure("This is the first episode of a cartoon series: the engine must write cast.json (the characters). It did not. Run the step again.");
  });
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new KnownFailure("The engine's cast.json is not valid JSON. Run the step again.");
  }
  const r = parseCast(json);
  if (!r.ok) throw new KnownFailure(`The engine's cast.json is not usable: ${r.message} Run the step again.`);
  await setVideoCast(db, videoId, r.cast);
  const seriesId = await videoSeriesId(db, videoId);
  if (seriesId) await saveSeriesCast(db, seriesId, r.cast);
  return r.cast;
}
