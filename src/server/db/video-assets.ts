import type { Db } from "./stages";

// Links existing local image assets to a video's beats (migration 0044). No network, no spend.
// Asset ids in scene docs are the assets.id uuid itself (lowercase, passes the scene assetId rule; the Render stage looks the file up by it).

export const MAX_PER_BEAT = 6;
export const MAX_PER_VIDEO = 40;

export class LinkRefused extends Error {}

export interface LinkInput {
  videoId: string;
  assetId: string;
  beatId: string;
  credit?: string | null;
  sourceUrl?: string | null;
  licence?: string | null;
  /** Set only by the pictures stage (hash of the beat brief it picked this for). */
  briefHash?: string | null;
  position?: number;
}
export interface VideoAsset {
  assetId: string;
  beatId: string;
  position: number;
  caption?: string;
  credit?: string;
  /** null = linked by hand; the pictures stage leaves those alone. */
  briefHash: string | null;
}

/** Links one image to a beat. Linking the same (video, asset, beat) again changes nothing. */
export async function linkAsset(db: Db, a: LinkInput): Promise<void> {
  if (a.beatId.length < 1 || a.beatId.length > 64) throw new LinkRefused("The beat id must be 1 to 64 characters.");
  const asset = await db.query<{ kind: string }>("select kind from assets where id = $1 and deleted_at is null", [a.assetId]);
  if (!asset.rows[0]) throw new LinkRefused("That asset does not exist.");
  if (asset.rows[0].kind !== "image") throw new LinkRefused("Only images can be linked to a beat.");
  const have = await db.query("select 1 from video_assets where video_id = $1 and asset_id = $2 and beat_id = $3", [a.videoId, a.assetId, a.beatId]);
  if (have.rows.length > 0) return;
  const n = await db.query<{ beat: number; video: number }>(
    "select count(*) filter (where beat_id = $2)::int as beat, count(*)::int as video from video_assets where video_id = $1",
    [a.videoId, a.beatId],
  );
  if (n.rows[0]!.beat >= MAX_PER_BEAT) throw new LinkRefused(`A beat can have at most ${MAX_PER_BEAT} pictures.`);
  if (n.rows[0]!.video >= MAX_PER_VIDEO) throw new LinkRefused(`A video can have at most ${MAX_PER_VIDEO} pictures.`);
  await db.query(
    `insert into video_assets (video_id, asset_id, beat_id, position, credit, source_url, licence, brief_hash) values ($1,$2,$3,$4,$5,$6,$7,$8)
     on conflict (video_id, asset_id, beat_id) do nothing`,
    [a.videoId, a.assetId, a.beatId, a.position ?? 0, a.credit ?? null, a.sourceUrl ?? null, a.licence ?? null, a.briefHash ?? null],
  );
}

/** Linked pictures that are still live, in beat order of position then link time. */
export async function assetsForVideo(db: Db, videoId: string): Promise<VideoAsset[]> {
  const { rows } = await db.query<{ asset_id: string; beat_id: string; position: number; caption: string | null; credit: string | null; brief_hash: string | null }>(
    `select va.asset_id, va.beat_id, va.position, a.caption, va.credit, va.brief_hash
       from video_assets va join assets a on a.id = va.asset_id
      where va.video_id = $1 and a.deleted_at is null
      order by va.beat_id, va.position, va.created_at, va.asset_id`,
    [videoId],
  );
  return rows.map((r) => ({
    assetId: r.asset_id, beatId: r.beat_id, position: r.position, briefHash: r.brief_hash,
    ...(r.caption ? { caption: r.caption } : {}), ...(r.credit ? { credit: r.credit } : {}),
  }));
}

export async function unlinkAll(db: Db, videoId: string): Promise<void> {
  await db.query("delete from video_assets where video_id = $1", [videoId]);
}

/** Distinct attribution lines for later use in the description / metadata. */
export async function creditsForVideo(db: Db, videoId: string): Promise<string[]> {
  const { rows } = await db.query<{ credit: string }>("select distinct credit from video_assets where video_id = $1 and credit is not null and credit <> '' order by credit", [videoId]);
  return rows.map((r) => r.credit);
}

/** Removes the links the pictures stage made (brief_hash set) for these beats; hand-made links stay. */
export async function unlinkStageBeats(db: Db, videoId: string, beatIds: readonly string[]): Promise<void> {
  if (beatIds.length === 0) return;
  await db.query("delete from video_assets where video_id = $1 and beat_id = any($2::text[]) and brief_hash is not null", [videoId, [...beatIds]]);
}
