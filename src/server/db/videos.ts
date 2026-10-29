import type pg from "pg";

export type VideoFormat = "short" | "long";
export type VideoKind = "scene_kit" | "tsx" | "collage" | "ai";
export type VideoLanguage = "en" | "hi" | "ta" | "te" | "ml" | "kn";
export type ContentKind = "script" | "beats" | "evidence" | "cost_plan" | "video" | "metadata" | "titles" | "narration" | "captions";

export interface VideoInput {
  format: VideoFormat;
  kind: VideoKind;
  language: VideoLanguage;
  topic: string;
  notes?: string | null;
  channelId?: string | null;
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

const VCOLS = "id, format, kind, language, topic, notes, channel_id, status, created_at, updated_at";
const CCOLS = "id, video_id, kind, version, sha256, body, file_path, produced_by, created_at";

export async function createVideoRow(db: pg.Pool, i: VideoInput): Promise<VideoRow> {
  const r = await db.query(
    `insert into videos (format, kind, language, topic, notes, channel_id) values ($1,$2,$3,$4,$5,$6) returning ${VCOLS}`,
    [i.format, i.kind, i.language, i.topic, i.notes ?? null, i.channelId ?? null],
  );
  const x = r.rows[0];
  return { id: x.id, format: x.format, kind: x.kind, language: x.language, topic: x.topic, notes: x.notes, channelId: x.channel_id, status: x.status, createdAt: x.created_at, updatedAt: x.updated_at };
}

export type ContentInput = { sha256: string; producedBy?: string | null } & ({ body: unknown; filePath?: undefined } | { filePath: string; body?: undefined });

/** Adds the next version of a kind. Concurrent adds are serialised per video+kind with a transaction advisory lock. */
export async function addContent(db: pg.Pool, videoId: string, kind: ContentKind, c: ContentInput): Promise<{ version: number }> {
  const hasBody = c.body !== undefined;
  if (hasBody === (c.filePath !== undefined)) throw new Error("addContent: give exactly one of body or filePath");
  const client = await db.connect();
  try {
    await client.query("begin");
    await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [`video_content:${videoId}:${kind}`]);
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
