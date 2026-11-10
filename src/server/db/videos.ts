import type pg from "pg";

export type VideoFormat = "short" | "long";
export type VideoKind = "scene_kit" | "tsx" | "collage" | "ai" | "scale3d" | "scene3d" | "scene3d_code";
export type VideoLanguage = "en" | "hi" | "ta" | "te" | "ml" | "kn";
export type ContentKind = "script" | "beats" | "evidence" | "cost_plan" | "video" | "metadata" | "titles" | "narration" | "captions" | "scenes" | "tsx" | "frame_review" | "previews" | "review" | "outline" | "thumbnail";

export interface VideoInput {
  format: VideoFormat;
  kind: VideoKind;
  language: VideoLanguage;
  topic: string;
  notes?: string | null;
  channelId?: string | null;
  /** null = default look */
  style?: string | null;
  captionStyle?: string | null;
  /** long videos only: the minutes range chosen in the New form (both or neither) */
  lengthMinMinutes?: number | null;
  lengthMaxMinutes?: number | null;
}
export interface VideoRow extends Required<Omit<VideoInput, never>> {
  id: string;
  status: "active" | "waiting" | "done" | "failed" | "cancelled";
  createdAt: Date;
  updatedAt: Date;
}
export interface ContentRow {
  id: string;
  videoId: string;
  kind: ContentKind;
  version: number;
  sha256: string;
  body: unknown;
  filePath: string | null;
  producedBy: string | null;
  createdAt: Date;
}

const VCOLS = "id, format, kind, language, topic, notes, channel_id, style, caption_style, length_min_minutes, length_max_minutes, status, created_at, updated_at";
const CCOLS = "id, video_id, kind, version, sha256, body, file_path, produced_by, created_at";

export async function createVideoRow(db: Pick<pg.Pool, "query">, i: VideoInput): Promise<VideoRow> {
  const r = await db.query(
    `insert into videos (format, kind, language, topic, notes, channel_id, style, caption_style, length_min_minutes, length_max_minutes) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning ${VCOLS}`,
    [i.format, i.kind, i.language, i.topic, i.notes ?? null, i.channelId ?? null, i.style ?? null, i.captionStyle ?? null, i.lengthMinMinutes ?? null, i.lengthMaxMinutes ?? null],
  );
  const x = r.rows[0];
  return { id: x.id, format: x.format, kind: x.kind, language: x.language, topic: x.topic, notes: x.notes, channelId: x.channel_id, style: x.style, captionStyle: x.caption_style, lengthMinMinutes: x.length_min_minutes, lengthMaxMinutes: x.length_max_minutes, status: x.status, createdAt: x.created_at, updatedAt: x.updated_at };
}

export type ContentInput = { sha256: string; producedBy?: string | null } & ({ body: unknown; filePath?: undefined } | { filePath: string; body?: undefined });

/** Adds the next version of a kind. Concurrent adds are serialised per video+kind with a transaction advisory lock. */
export async function addContent(db: pg.Pool, videoId: string, kind: ContentKind, c: ContentInput): Promise<{ version: number }> {
  return (await insertContent(db, videoId, kind, c))!;
}

/** Like addContent, but writes only if the newest version of the kind is still `latestId` (null = none yet): a double submit adds one version. Returns null when it moved on. */
export async function addContentIfLatest(db: pg.Pool, videoId: string, kind: ContentKind, c: ContentInput, latestId: string | null): Promise<{ version: number } | null> {
  return insertContent(db, videoId, kind, c, latestId);
}

async function insertContent(db: pg.Pool, videoId: string, kind: ContentKind, c: ContentInput, latestId?: string | null): Promise<{ version: number } | null> {
  const hasBody = c.body !== undefined;
  if (hasBody === (c.filePath !== undefined)) throw new Error("addContent: give exactly one of body or filePath");
  const client = await db.connect();
  try {
    await client.query("begin");
    await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [`video_content:${videoId}:${kind}`]);
    if (latestId !== undefined) {
      const cur = await client.query<{ id: string }>("select id from video_content where video_id = $1 and kind = $2 order by version desc limit 1", [videoId, kind]);
      if ((cur.rows[0]?.id ?? null) !== latestId) {
        await client.query("rollback");
        return null;
      }
    }
    const r = await client.query(
      `insert into video_content (video_id, kind, version, sha256, body, file_path, produced_by)
       values ($1, $2, (select coalesce(max(version), 0) + 1 from video_content where video_id = $1 and kind = $2), $3, $4, $5, $6)
       returning version`,
      [videoId, kind, c.sha256, hasBody ? JSON.stringify(c.body) : null, c.filePath ?? null, c.producedBy ?? null],
    );
    await client.query("commit");
    return { version: r.rows[0].version };
  } catch (e) {
    await client.query("rollback").catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
}

export async function latestContent(db: pg.Pool, videoId: string, kind: ContentKind): Promise<ContentRow | null> {
  const r = await db.query(`select ${CCOLS} from video_content where video_id = $1 and kind = $2 order by version desc limit 1`, [videoId, kind]);
  const x = r.rows[0];
  return x ? { id: x.id, videoId: x.video_id, kind: x.kind, version: x.version, sha256: x.sha256, body: x.body, filePath: x.file_path, producedBy: x.produced_by, createdAt: x.created_at } : null;
}
