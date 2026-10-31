import type pg from "pg";
import type { ChildRegistry } from "@/server/render/child";
import { argsHash, commandLabelOf, readProcInfo } from "@/server/render/proc-info";

const QUERY_TIMEOUT_MS = 5000;
// pg honours query_timeout on a query config but its typings omit it.
const timed = (text: string, values: unknown[]): pg.QueryConfig => ({ text, values, query_timeout: QUERY_TIMEOUT_MS }) as pg.QueryConfig;

/** Registry used by runChild: one row per live child, removed when the run ends. Queries time out, so a DB stall cannot hang a run. */
export function createChildRegistry(db: pg.Pool, workerId: string): ChildRegistry {
  return {
    async register(r) {
      await db.query(
        timed(
          `insert into child_processes (pid, started_at_epoch, command_label, args_sha256, worker_id, stage_run_id) values ($1,$2,$3,$4,$5,$6)
           on conflict (pid, started_at_epoch) do update set command_label = excluded.command_label, args_sha256 = excluded.args_sha256,
             worker_id = excluded.worker_id, stage_run_id = excluded.stage_run_id`,
          [r.pid, r.startedAtEpoch, r.commandLabel, r.argsSha256, workerId, r.stageRunId],
        ),
      );
    },
    async unregister(pid, startedAtEpoch) {
      await db.query(timed("delete from child_processes where pid = $1 and started_at_epoch = $2", [pid, startedAtEpoch]));
    },
  };
}

// A worker proves it is alive by holding a Postgres session advisory lock named after its id on a dedicated connection.
// The lock vanishes the moment that connection dies (process killed, network cut), so "lock is free" means "that worker is dead".
const LOCK_SQL = "hashtextextended('yt-child-worker:' || $1, 0)";

export interface WorkerLock {
  release(): Promise<void>;
}

/**
 * Call once per worker, AFTER sweepOrphans at boot. Throws if another live process already holds this worker id.
 * Keep the returned lock for the life of the worker; its connection is checked out of the pool on purpose.
 */
export async function holdWorkerLock(db: pg.Pool, workerId: string): Promise<WorkerLock> {
  const client = await db.connect();
  try {
    const { rows } = await client.query<{ ok: boolean }>(`select pg_try_advisory_lock(${LOCK_SQL}) as ok`, [workerId]);
    if (!rows[0]?.ok) throw new Error(`Another worker is already running with id ${workerId}.`);
  } catch (e) {
    client.release();
    throw e;
  }
  let released = false;
  return {
    async release() {
      if (released) return;
      released = true;
      try {
        await client.query(`select pg_advisory_unlock(${LOCK_SQL})`, [workerId]);
        client.release();
      } catch {
        client.release(true); // drop the connection: that frees the lock too
      }
    },
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const probe = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
};

interface Row {
  pid: number;
  started_at_epoch: string;
  command_label: string;
  args_sha256: string;
  worker_id: string;
}
interface Target {
  row: Row;
  group: boolean;
}
const exists = (t: Target): boolean => probe(t.group ? -t.row.pid : t.row.pid);
const send = (t: Target, sig: NodeJS.Signals): void => {
  try {
    process.kill(t.group ? -t.row.pid : t.row.pid, sig);
  } catch {
    /* gone */
  }
};

async function targetFor(r: Row): Promise<Target | "stale" | "unknown"> {
  if (r.pid === process.pid) return "stale";
  if (!probe(r.pid)) {
    // The leader is dead but its group may live on (grandchildren). The kernel never hands out a pid that is still a live
    // process-group id, so a live group with this id is the one we recorded.
    return probe(-r.pid) ? { row: r, group: true } : "stale";
  }
  const info = await readProcInfo(r.pid);
  if (!info) return "unknown"; // alive but unreadable: leave the process and the row alone
  const same =
    Math.abs(info.startedAtEpoch - Number(r.started_at_epoch)) <= 1 && argsHash(info.args) === r.args_sha256 && commandLabelOf(info.args) === r.command_label;
  if (!same) return "stale"; // a different process reused the pid
  return { row: r, group: info.pgid === r.pid };
}

/** True while some live worker holds this id's advisory lock (holdWorkerLock). The check takes the lock and gives it straight back. */
export async function isWorkerAlive(db: pg.Pool, workerId: string): Promise<boolean> {
  const client = await db.connect();
  try {
    const got = await client.query<{ ok: boolean }>(`select pg_try_advisory_lock(${LOCK_SQL}) as ok`, [workerId]);
    if (!got.rows[0]?.ok) return true;
    await client.query(`select pg_advisory_unlock(${LOCK_SQL})`, [workerId]);
    return false;
  } finally {
    client.release();
  }
}

/**
 * Worker boot: kills children left behind by DEAD workers. Rows are grouped by worker id, and a worker is acted on only when
 * its advisory lock (holdWorkerLock) can be taken here, i.e. nobody is alive under that id; a live worker's rows are never
 * touched. Within a row, the process is killed only if pid, start time (to the second, UTC) and full command line match what
 * was recorded, so a recycled pid is safe. If the leader is already dead, the surviving group is killed anyway. A row is deleted
 * only once its process is really gone. Returns how many orphans were killed. `workerId` is the booting worker (informational).
 */
export async function sweepOrphans(db: pg.Pool, workerId: string, opts: { killGraceMs?: number } = {}): Promise<number> {
  void workerId;
  const grace = opts.killGraceMs ?? 2000;
  const client = await db.connect();
  let killed = 0;
  try {
    const { rows: ids } = await client.query<{ worker_id: string }>("select distinct worker_id from child_processes");
    for (const { worker_id } of ids) {
      const got = await client.query<{ ok: boolean }>(`select pg_try_advisory_lock(${LOCK_SQL}) as ok`, [worker_id]);
      if (!got.rows[0]?.ok) continue; // that worker is alive
      try {
        killed += await sweepWorker(client, worker_id, grace);
      } finally {
        await client.query(`select pg_advisory_unlock(${LOCK_SQL})`, [worker_id]);
      }
    }
  } finally {
    client.release();
  }
  return killed;
}

async function sweepWorker(client: pg.PoolClient, workerId: string, grace: number): Promise<number> {
  const { rows } = await client.query<Row>(
    "select pid, started_at_epoch, command_label, args_sha256, worker_id from child_processes where worker_id = $1 order by registered_at",
    [workerId],
  );
  const targets: Target[] = [];
  const deletable: Row[] = [];
  for (const r of rows) {
    const t = await targetFor(r);
    if (t === "stale") deletable.push(r);
    else if (t !== "unknown") targets.push(t);
  }
  for (const t of targets) send(t, "SIGTERM");
  let end = Date.now() + grace;
  while (Date.now() < end && targets.some(exists)) await sleep(25);
  for (const t of targets) if (exists(t)) send(t, "SIGKILL");
  end = Date.now() + 2000;
  while (Date.now() < end && targets.some(exists)) await sleep(25);
  let killed = 0;
  for (const t of targets) {
    if (exists(t)) continue; // still alive after SIGKILL: keep the row so the next boot tries again
    deletable.push(t.row);
    killed++;
  }
  if (deletable.length) {
    await client.query(
      "delete from child_processes using unnest($1::int[], $2::bigint[]) as d(pid, started) where child_processes.pid = d.pid and child_processes.started_at_epoch = d.started",
      [deletable.map((r) => r.pid), deletable.map((r) => r.started_at_epoch)],
    );
  }
  return killed;
}
