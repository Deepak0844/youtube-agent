import type pg from "pg";
import type { ToolCheck } from "@/server/core/tool-check";

export async function saveWorkerToolChecks(db: pg.Pool, checks: ToolCheck[]): Promise<void> {
  await db.query(
    "insert into worker_tool_checks (id, checks, at) values (true, $1::jsonb, now()) on conflict (id) do update set checks = excluded.checks, at = excluded.at",
    [JSON.stringify(checks)],
  );
}

/** null until the worker has reported once. */
export async function readWorkerToolChecks(db: pg.Pool): Promise<{ checks: ToolCheck[]; at: Date } | null> {
  const r = await db.query<{ checks: ToolCheck[]; at: Date }>("select checks, at from worker_tool_checks where id");
  return r.rows[0] ?? null;
}
