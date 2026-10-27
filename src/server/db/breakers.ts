import type pg from "pg";
import { breakerAllows, breakerStep, CLOSED, type BreakerConfig, type BreakerEvent, type BreakerState } from "@/server/core/breaker";
import { getEngineConfig } from "./engine-config";

// Breaker state per guarded stage. Time is the DATABASE clock, so a Mac sleep or a wall-clock jump cannot skew a cooldown.
interface Row {
  status: BreakerState["status"];
  failures: number;
  opened_ms: number | null;
  now_ms: number;
}

async function loadConfig(db: pg.Pool | pg.PoolClient): Promise<{ cfg: BreakerConfig; stages: readonly string[] }> {
  const c = await getEngineConfig(db);
  return { cfg: { threshold: c.breaker.threshold, cooldownMs: c.breaker.cooldownS * 1000 }, stages: c.breaker.stages };
}

const SELECT = `select status, failures, (extract(epoch from opened_at) * 1000)::float8 as opened_ms,
                (extract(epoch from clock_timestamp()) * 1000)::float8 as now_ms from breakers where stage = $1`;

const toState = (r: Row | undefined): BreakerState => (r ? { status: r.status, failures: r.failures, openedAtMs: r.opened_ms } : CLOSED);

/** Records a stage outcome. A stage not in `breaker.stages` is never held: failure/success are ignored and a reset is refused. */
export async function recordBreakerEvent(db: pg.Pool, stage: string, event: BreakerEvent): Promise<BreakerState> {
  const { cfg, stages } = await loadConfig(db);
  if (!stages.includes(stage)) {
    if (event === "reset") throw new Error(`unknown breaker stage: ${stage}`);
    return CLOSED;
  }
  const client = await db.connect();
  try {
    await client.query("begin");
    await client.query("insert into breakers (stage) values ($1) on conflict (stage) do nothing", [stage]);
    await client.query("select 1 from breakers where stage = $1 for update", [stage]);
    const { rows } = await client.query<Row>(SELECT, [stage]);
    const row = rows[0]!;
    const next = breakerStep(toState(row), event, row.now_ms, cfg);
    await client.query(
      `update breakers set status = $2, failures = $3,
         opened_at = case when $4::float8 is null then null else to_timestamp($4::float8 / 1000.0) end, updated_at = clock_timestamp()
       where stage = $1`,
      [stage, next.status, next.failures, next.openedAtMs],
    );
    await client.query("commit");
    return next;
  } catch (err) {
    await client.query("rollback").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** True when new work for `stage` may start now. Stages not guarded are always allowed. */
export async function breakerAllowsNow(db: pg.Pool, stage: string): Promise<boolean> {
  const { cfg, stages } = await loadConfig(db);
  if (!stages.includes(stage)) return true;
  const { rows } = await db.query<Row>(SELECT, [stage]);
  const now = rows[0]?.now_ms ?? (await db.query<{ n: number }>("select (extract(epoch from clock_timestamp()) * 1000)::float8 as n")).rows[0]!.n;
  return breakerAllows(toState(rows[0]), now, cfg);
}
