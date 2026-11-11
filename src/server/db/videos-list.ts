import type pg from "pg";
import { PAGE_SIZE, type LibraryFilter } from "@/server/core/videos-view";
import type { VideoFormat, VideoKind, VideoLanguage, VideoRow } from "@/server/db/videos";

export interface LibraryRow {
  id: string;
  topic: string;
  format: VideoFormat;
  kind: VideoKind;
  language: VideoLanguage;
  status: VideoRow["status"];
  createdAt: Date;
  /** Newest of the video's own update and its latest stage run. */
  lastActivity: Date;
  /** Settled spend so far, micro-USD (1 USD = 1_000_000). */
  costMicroUsd: number;
}

/** Newest first, one page (default PAGE_SIZE from `f.page`). `total` counts every match of the filters. */
export async function listVideos(
  db: pg.Pool,
  f: LibraryFilter,
  page: { limit: number; offset: number } = { limit: PAGE_SIZE, offset: (f.page - 1) * PAGE_SIZE },
): Promise<{ rows: LibraryRow[]; total: number; hasNext: boolean }> {
  const r = await db.query(
    `select v.id, v.topic, v.format, v.kind, v.language, v.status, v.created_at, count(*) over () as total,
            greatest(v.updated_at, x.last) as last_activity, x.cost
       from videos v
       left join lateral (
         select max(sr.updated_at) as last, coalesce(sum(si.actual_micro_usd) filter (where si.status = 'done'), 0) as cost
           from stage_runs sr left join spend_intents si on si.stage_run_id = sr.id
          where sr.video_id = v.id
       ) x on true
      where ($1::text is null or v.format = $1) and ($2::text is null or v.status = $2)
        and ($3::text is null or v.language = $3) and ($4::text is null or v.kind = $4)
      order by v.created_at desc, v.id desc
      limit $5 offset $6`,
    [f.format ?? null, f.status ?? null, f.language ?? null, f.kind ?? null, page.limit, page.offset],
  );
  const total = r.rows.length ? Number(r.rows[0].total) : page.offset === 0 ? 0 : await countVideos(db, f);
  const rows = r.rows.map(
    (x): LibraryRow => ({ id: x.id, topic: x.topic, format: x.format, kind: x.kind, language: x.language, status: x.status, createdAt: x.created_at, lastActivity: x.last_activity, costMicroUsd: Number(x.cost) }),
  );
  return { rows, total, hasNext: page.offset + rows.length < total };
}

/** Count only (a page past the end has no rows to carry the window count). */
async function countVideos(db: pg.Pool, f: LibraryFilter): Promise<number> {
  const r = await db.query<{ n: string }>(
    `select count(*) as n from videos v
      where ($1::text is null or v.format = $1) and ($2::text is null or v.status = $2)
        and ($3::text is null or v.language = $3) and ($4::text is null or v.kind = $4)`,
    [f.format ?? null, f.status ?? null, f.language ?? null, f.kind ?? null],
  );
  return Number(r.rows[0]?.n ?? 0);
}

/** ⌘K jump-to: videos whose title contains `q` (case-insensitive; % and _ match literally), newest first. Blank → []. */
export async function searchVideoTitles(db: Pick<pg.Pool, "query">, q: string, limit = 8): Promise<Array<{ id: string; title: string; format: VideoFormat }>> {
  const term = q.trim();
  if (!term) return [];
  const r = await db.query<{ id: string; topic: string; format: VideoFormat }>(
    `select id, topic, format from videos
      where topic ilike '%' || replace(replace(replace($1, '\\', '\\\\'), '%', '\\%'), '_', '\\_') || '%'
      order by created_at desc, id desc limit $2`,
    [term, limit],
  );
  return r.rows.map((x) => ({ id: x.id, title: x.topic, format: x.format }));
}
