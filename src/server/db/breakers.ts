import type pg from "pg";
import { actorProblem, type GateActor } from "@/server/core/approvals";
import { admitBreaker, breakerAllows, breakerStep, CLOSED, holdUntilMs, type BreakerConfig, type BreakerEvent, type BreakerState } from "@/server/core/breaker";
import { recordAudit } from "./audit";
import { getEngineConfig } from "./engine-config";
import { atomic, type Db } from "./stages";

// Breaker state per guarded stage. Time is the DATABASE clock, so a Mac sleep or a wall-clock jump cannot skew a cooldown.
interface Row {
  status: BreakerState["status"];
  failures: number;
  opened_ms: number | null;
  probe_ms: number | null;
  now_ms: number;
}

async function loadConfig(db: Db): Promise<{ cfg: BreakerConfig; stages: readonly string[] }> {
  const c = await getEngineConfig(db);
  return { cfg: { threshold: c.breaker.threshold, cooldownMs: c.breaker.cooldownS * 1000 }, stages: c.breaker.stages };
}

const SELECT = `select status, failures, (extract(epoch from opened_at) * 1000)::float8 as opened_ms,
                (extract(epoch from probe_at) * 1000)::float8 as probe_ms,
                (extract(epoch from clock_timestamp()) * 1000)::float8 as now_ms from breakers where stage = $1`;

const toState = (r: Row | undefined): BreakerState => (r ? { status: r.status, failures: r.failures, openedAtMs: r.opened_ms } : CLOSED);

/** Records a stage outcome. A stage not in `breaker.stages` is never held: failure/success are ignored and a reset is refused. */
export type BreakerResult = BreakerState & { justOpened: boolean };

/** `inTx` runs inside the same transaction, just before commit (used for the audit row of a reset): if it throws, nothing changes. */
export async function recordBreakerEvent(db: pg.Pool, stage: string, event: BreakerEvent, inTx?: (client: pg.PoolClient) => Promise<void>): Promise<BreakerResult> {
  const { cfg, stages } = await loadConfig(db);
  if (!stages.includes(stage)) {
    if (event === "reset") throw new Error(`unknown breaker stage: ${stage}`);
    return { ...CLOSED, justOpened: false };
  }
  const client = await db.connect();
  try {
    await client.query("begin");
    await client.query("insert into breakers (stage) values ($1) on conflict (stage) do nothing", [stage]);
    await client.query("select 1 from breakers where stage = $1 for update", [stage]);
    const { rows } = await client.query<Row>(SELECT, [stage]);
    const row = rows[0]!;
    const before = toState(row);
    const next = breakerStep(before, event, row.now_ms, cfg);
    // Any reported outcome ends the half-open probe, so probe_at is cleared with it.
    await client.query(
      `update breakers set status = $2, failures = $3, probe_at = null,
         opened_at = case when $4::float8 is null then null else to_timestamp($4::float8 / 1000.0) end, updated_at = clock_timestamp()
       where stage = $1`,
      [stage, next.status, next.failures, next.openedAtMs],
    );
    if (inTx) await inTx(client);
    await client.query("commit");
    // "Just opened" = it was not holding before this event (closed, or half open after its cooldown) and is now.
    const wasHolding = !breakerAllows(before, row.now_ms, cfg);
    return { ...next, justOpened: next.status === "open" && !wasHolding };
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

async function readRow(db: Db, stage: string): Promise<Row> {
  const { rows } = await db.query<Row>(SELECT, [stage]);
  return rows[0] ?? { status: "closed", failures: 0, opened_ms: null, probe_ms: null, now_ms: (await db.query<{ n: number }>("select (extract(epoch from clock_timestamp()) * 1000)::float8 as n")).rows[0]!.n };
}

/** `probe` is true when this admission used the single half-open probe slot (release it if no stage row ends up created). */
export type Admission = { allowed: true; probe: boolean } | { allowed: false; until: Date | null };

/**
 * Asks whether ONE new stage may start now. Closed or unguarded: yes. Open: no. Half open: the first caller takes the
 * single probe slot (recorded under a row lock, in the caller's transaction when given a client) and every other caller
 * is held until the probe reports or ages out. The caller must create its stage row in the same transaction, so a probe
 * is only spent on a stage that really exists.
 */
export async function admitStage(db: Db, stage: string): Promise<Admission> {
  const { cfg, stages } = await loadConfig(db);
  if (!stages.includes(stage) || cfg.threshold <= 0) return { allowed: true, probe: false };
  const deny = (row: Row): Admission => {
    const until = holdUntilMs(toState(row), row.probe_ms, row.now_ms, cfg);
    return { allowed: false, until: until === null ? null : new Date(until) };
  };
  const first = await readRow(db, stage);
  const d = admitBreaker(toState(first), first.probe_ms, first.now_ms, cfg);
  if (!d.takesProbe) return d.allowed ? { allowed: true, probe: false } : deny(first);
  await db.query("insert into breakers (stage) values ($1) on conflict (stage) do nothing", [stage]);
  return atomic(db, async (q) => {
    await q.query("select 1 from breakers where stage = $1 for update", [stage]);
    const row = await readRow(q as Db, stage);
    const again = admitBreaker(toState(row), row.probe_ms, row.now_ms, cfg);
    if (!again.allowed) return deny(row);
    if (again.takesProbe) await q.query("update breakers set probe_at = clock_timestamp(), updated_at = clock_timestamp() where stage = $1", [stage]);
    return { allowed: true, probe: again.takesProbe } as Admission;
  });
}

/** Gives the half-open probe slot back (no stage row was created after all). Harmless when none is held. */
export async function releaseProbe(db: Db, stage: string): Promise<void> {
  await db.query("update breakers set probe_at = null, updated_at = clock_timestamp() where stage = $1 and probe_at is not null", [stage]);
}

/** Read-only: when is this stage held until? null = a stage may start now (or the stage is not guarded). For the "paused" text. */
export async function breakerHold(db: Db, stage: string): Promise<{ until: Date | null } | null> {
  const { cfg, stages } = await loadConfig(db);
  if (!stages.includes(stage) || cfg.threshold <= 0) return null;
  const row = await readRow(db, stage);
  if (admitBreaker(toState(row), row.probe_ms, row.now_ms, cfg).allowed) return null;
  const until = holdUntilMs(toState(row), row.probe_ms, row.now_ms, cfg);
  return { until: until === null ? null : new Date(until) };
}

/** Owner action: closes the breaker at once. A signed-in session only; the reset is audited. Phase 7 puts a button on /settings/health, Task 24 one on /queue. */
export async function resetBreaker(db: pg.Pool, stage: string, actor: GateActor): Promise<{ ok: true } | { ok: false; reason: string }> {
  const bad = actorProblem(actor);
  if (bad) return { ok: false, reason: bad };
  const { stages } = await loadConfig(db);
  if (!stages.includes(stage)) return { ok: false, reason: "that stage has no breaker" };
  // The audit row is written in the reset's own transaction: no reset without its audit row, and no audit row without a reset.
  await recordBreakerEvent(db, stage, "reset", (client) => recordAudit(client, "breaker.reset", { stage, sessionId: actor.sessionId }));
  return { ok: true };
}
