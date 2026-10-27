import type pg from "pg";
import type { ChildRegistry } from "@/server/render/child";
import { commandLabelOf, readProcInfo } from "@/server/render/proc-info";

/** Registry used by runChild: one row per live child, removed when the run ends. */
export function createChildRegistry(db: pg.Pool, workerId: string): ChildRegistry {
  return {
    async register(r) {
      await db.query(
        `insert into child_processes (pid, started_at_epoch, command_label, worker_id, stage_run_id) values ($1,$2,$3,$4,$5)
         on conflict (pid, started_at_epoch) do update set command_label = excluded.command_label, worker_id = excluded.worker_id, stage_run_id = excluded.stage_run_id`,
        [r.pid, r.startedAtEpoch, r.commandLabel, workerId, r.stageRunId],
      );
    },
    async unregister(pid, startedAtEpoch) {
      await db.query("delete from child_processes where pid = $1 and started_at_epoch = $2", [pid, startedAtEpoch]);
    },
  };
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Worker boot: kills children a previous (dead) worker left behind. A row is acted on only if the pid is alive AND its start
 * time (to the second) AND its command name still match what was recorded, so a recycled pid is never killed. Every row is
 * deleted afterwards. One worker per host is assumed: at boot this worker has registered nothing yet, so all rows are orphans.
 * Returns how many processes were killed. `workerId` is the booting worker (logged by the caller; its own pid is never touched).
 */
export async function sweepOrphans(db: pg.Pool, workerId: string, opts: { killGraceMs?: number } = {}): Promise<number> {
  void workerId;
  const grace = opts.killGraceMs ?? 2000;
  const { rows } = await db.query<{ pid: number; started_at_epoch: string; command_label: string }>(
    "select pid, started_at_epoch, command_label from child_processes order by registered_at",
  );
  const targets: Array<{ pid: number; group: boolean }> = [];
  for (const r of rows) {
    if (r.pid === process.pid || !alive(r.pid)) continue;
    const info = await readProcInfo(r.pid);
    if (!info) continue;
    if (Math.abs(info.startedAtEpoch - Number(r.started_at_epoch)) > 1) continue;
    if (commandLabelOf(info.args) !== r.command_label) continue;
    targets.push({ pid: r.pid, group: info.pgid === r.pid });
  }
  const send = (t: { pid: number; group: boolean }, sig: NodeJS.Signals): void => {
    try {
      process.kill(t.group ? -t.pid : t.pid, sig);
    } catch {
      /* gone */
    }
  };
  for (const t of targets) send(t, "SIGTERM");
  const end = Date.now() + grace;
  while (Date.now() < end && targets.some((t) => alive(t.pid))) await sleep(25);
  for (const t of targets) if (alive(t.pid)) send(t, "SIGKILL");
  // Only the rows read above: a row registered meanwhile belongs to a live child.
  await db.query(
    "delete from child_processes using unnest($1::int[], $2::bigint[]) as d(pid, started) where child_processes.pid = d.pid and child_processes.started_at_epoch = d.started",
    [rows.map((r) => r.pid), rows.map((r) => r.started_at_epoch)],
  );
  return targets.length;
}
