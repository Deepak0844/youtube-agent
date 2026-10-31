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

/** Newest first, one page of PAGE_SIZE. `hasNext` is found by asking for one extra row. */
export async function listVideos(db: pg.Pool, f: LibraryFilter): Promise<{ rows: LibraryRow[]; hasNext: boolean }> {
  const r = await db.query(
    `select v.id, v.topic, v.format, v.kind, v.language, v.status, v.created_at,
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
    [f.format ?? null, f.status ?? null, f.language ?? null, f.kind ?? null, PAGE_SIZE + 1, (f.page - 1) * PAGE_SIZE],
  );
  const rows = r.rows.slice(0, PAGE_SIZE).map(
    (x): LibraryRow => ({ id: x.id, topic: x.topic, format: x.format, kind: x.kind, language: x.language, status: x.status, createdAt: x.created_at, lastActivity: x.last_activity, costMicroUsd: Number(x.cost) }),
  );
  return { rows, hasNext: r.rows.length > PAGE_SIZE };
}
