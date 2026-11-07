import type pg from "pg";
import { dueJobs, type JobName } from "@/server/core/scheduler";
import { notifySafe, type NotifySend } from "@/server/db/notify";
import { loadScheduler } from "@/server/db/system-settings";

// The worker's scheduler: every tick it asks the pure rule what is due, claims each (job, run_key) in schedule_runs
// (the unique key means one run per period even with two workers), runs it, and records ok or failed. A failed run is not
// retried in the same period (parity with the old app: one run per night even if it fails) and sends the run_failed notice.

export type JobRunners = Partial<Record<JobName, () => Promise<string | void>>>;

// A failed job's own message can carry a provider's text: the log keeps only the error class.
const failure = (e: unknown): string => `The job failed (${e instanceof Error ? e.name : "Error"}). Check the worker log.`;

export async function runDueJobs(db: pg.Pool, runners: JobRunners, send: NotifySend | undefined, now: Date = new Date()): Promise<JobName[]> {
  const ran: JobName[] = [];
  for (const { job, runKey } of dueJobs(await loadScheduler(db), now)) {
    const run = runners[job];
    if (!run) continue;
    const claim = await db.query<{ id: string }>(
      "insert into schedule_runs (job, run_key) values ($1, $2) on conflict (job, run_key) do nothing returning id",
      [job, runKey],
    );
    const id = claim.rows[0]?.id;
    if (!id) continue;
    ran.push(job);
    try {
      const message = (await run()) || null;
      await db.query("update schedule_runs set status = 'ok', message = $2, finished_at = now() where id = $1", [id, message]);
    } catch (e) {
      const message = failure(e);
      await db.query("update schedule_runs set status = 'failed', message = $2, finished_at = now() where id = $1", [id, message]);
      await notifySafe(db, send, { event: "run_failed", from: "running", to: "run_failed", transitionId: `schedule.${id}`, detail: `${job}: ${message}` });
    }
  }
  return ran;
}

export interface ScheduleRunRow {
  job: string;
  runKey: string;
  status: string;
  message: string | null;
  startedAt: Date;
}

export async function recentRuns(db: pg.Pool, limit = 10): Promise<ScheduleRunRow[]> {
  const { rows } = await db.query<{ job: string; run_key: string; status: string; message: string | null; started_at: Date }>(
    "select job, run_key, status, message, started_at from schedule_runs order by started_at desc limit $1",
    [limit],
  );
  return rows.map((r) => ({ job: r.job, runKey: r.run_key, status: r.status, message: r.message, startedAt: r.started_at }));
}

/** Worker hook: at most one check a minute in this process; errors never reach the worker loop. */
export function throttledScheduler(db: pg.Pool, runners: JobRunners, send: NotifySend | undefined, everyMs = 60_000): () => Promise<void> {
  let last = 0;
  let busy = false;
  return async () => {
    const t = Date.now();
    if (busy || t - last < everyMs) return;
    busy = true;
    last = t;
    try {
      await runDueJobs(db, runners, send);
    } catch {
      // never reaches the worker loop
    } finally {
      busy = false;
    }
  };
}
