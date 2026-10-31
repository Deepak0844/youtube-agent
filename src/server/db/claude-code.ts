import type pg from "pg";
import { getSetting } from "@/server/db/settings";
import type { ClaudeCodeGate } from "@/server/llm/claude-code";

// The Claude Code switch and daily cap (ADR 0014). Read-only on settings; the counter is the only write.

export async function claudeCodeEnabled(db: pg.Pool | pg.PoolClient): Promise<boolean> {
  return (await getSetting(db, "claude_code.enabled")) === true;
}

/** Counts one call against today's (UTC) cap in one statement; false, with nothing counted, when the cap is reached. */
export async function takeClaudeCodeSlot(db: pg.Pool | pg.PoolClient): Promise<boolean> {
  const cap = await getSetting(db, "claude_code.daily_cap");
  if (typeof cap !== "number" || !Number.isInteger(cap) || cap < 1) return false;
  const { rowCount } = await db.query(
    `insert into claude_code_daily_calls as d (day, calls) values ((now() at time zone 'utc')::date, 1)
     on conflict (day) do update set calls = d.calls + 1 where d.calls < $1
     returning calls`,
    [cap],
  );
  return rowCount === 1;
}

export async function claudeCodeUsedToday(db: pg.Pool | pg.PoolClient): Promise<number> {
  const { rows } = await db.query<{ calls: number }>("select calls from claude_code_daily_calls where day = (now() at time zone 'utc')::date");
  return rows[0]?.calls ?? 0;
}

export function claudeCodeGate(db: pg.Pool): ClaudeCodeGate {
  return { enabled: () => claudeCodeEnabled(db), takeSlot: () => takeClaudeCodeSlot(db) };
}
