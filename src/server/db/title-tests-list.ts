import type pg from "pg";
import type { TitleTestResult } from "@/server/core/title-test";

// Read only list of title tests for /analytics. Planning and recording live in insights.ts.
export interface TitleTestLine {
  id: string;
  topic: string;
  titleA: string;
  titleB: string;
  status: string;
  result: TitleTestResult | null;
}

export async function listTitleTests(db: Pick<pg.Pool, "query">, limit = 10): Promise<TitleTestLine[]> {
  const { rows } = await db.query<{ id: string; topic: string; title_a: string; title_b: string; status: string; result: TitleTestResult | null }>(
    "select e.id::text, v.topic, e.title_a, e.title_b, e.status, e.result from title_experiments e join videos v on v.id = e.video_id order by e.created_at desc, e.id desc limit $1",
    [limit],
  );
  return rows.map((r) => ({ id: r.id, topic: r.topic, titleA: r.title_a, titleB: r.title_b, status: r.status, result: r.result }));
}
