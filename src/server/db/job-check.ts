import type pg from "pg";
import { actorProblem, type GateActor } from "@/server/core/approvals";
import { checkMessage, type CheckOutcome } from "@/server/core/job-check-rules";
import { recordAudit } from "./audit";
import { sessionIsLive } from "./decision";
import { settleCheckedJob } from "./media-jobs";
import { inTx } from "./pipeline";
import { settleIntent } from "./spend";
import type { JobCheckers, JobOutcome } from "@/server/providers/media-types";

// "Check the job" for a parked stage: ask the provider about the job id we ALREADY stored. Read only towards the provider:
// no submit, no new reservation, no new stage row, nothing released. Only a finished job changes money: the SAME reservation
// is settled with the same result shape the paid call would have stored, so "use the result" later replays it and pays nothing.
//
// Order: look (no lock) -> ask the provider and save the file (outside any transaction; the file is content-addressed, so a
// crash or a repeat only re-writes the same bytes) -> ONE transaction: lock the stage row, then the job, then settle (the
// global lock order: stage, intent, budgets). Whoever finds the job already done is a no-op, so a double click settles once.

export type CheckResult = { ok: true; outcome: CheckOutcome; message: string } | { ok: false; message: string };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NOT_OWNER = "only the signed-in owner can do this";

interface JobRow {
  id: string;
  step: number;
  provider: string;
  provider_job_id: string;
  quote: string;
}

class Stop extends Error {}

const res = (outcome: CheckOutcome): CheckResult => ({ ok: true, outcome, message: checkMessage(outcome) });

export interface CheckArgs {
  stageRunId: string;
  actor: GateActor;
}

export async function checkParkedJob(db: pg.Pool, checkers: JobCheckers, a: CheckArgs): Promise<CheckResult> {
  if (actorProblem(a?.actor)) return { ok: false, message: NOT_OWNER };
  if (typeof a.stageRunId !== "string" || !UUID_RE.test(a.stageRunId)) return { ok: false, message: "no such stage" };
  const sessionId = a.actor.sessionId;

  const head = await db.query<{ status: string; video_id: string }>("select status, video_id from stage_runs where id = $1", [a.stageRunId]);
  if (head.rows[0]?.status !== "needs_decision") return { ok: false, message: "This step is no longer waiting for a decision." };
  const { rows: all } = await db.query<JobRow & { state: string; open: boolean }>(
    `select j.id, j.step, j.provider, j.provider_job_id, j.quote_micro_usd::text as quote, j.state,
            exists (select 1 from spend_intents i where i.stage_run_id = j.stage_run_id and i.step_index = j.step and i.status in ('pending','unknown')) as open
       from media_jobs j where j.stage_run_id = $1 and j.provider_job_id is not null order by j.step`,
    [a.stageRunId],
  );
  const targets = all.filter((j) => (j.state === "submitted" || j.state === "unknown") && j.open && Object.hasOwn(checkers, j.provider));
  if (targets.length === 0) return all.some((j) => j.state === "done") ? res("already_done") : { ok: false, message: checkMessage("nothing_to_check") };

  const outcomes: CheckOutcome[] = [];
  for (const j of targets) {
    let found: JobOutcome;
    try {
      found = await checkers[j.provider]!.check({ providerJobId: j.provider_job_id, quoteMicroUsd: Number(j.quote) });
    } catch {
      found = { kind: "unknown" }; // anything unclear leaves the money exactly where it is
    }
    try {
      outcomes.push(await record(db, a.stageRunId, head.rows[0]!.video_id, sessionId, j, found));
    } catch (e) {
      if (e instanceof Stop) return { ok: false, message: e.message };
      throw e;
    }
  }
  // The worst news first: a job that is not finished decides what the owner reads.
  return res(outcomes.find((o) => o !== "done" && o !== "already_done") ?? (outcomes.every((o) => o === "already_done") ? "already_done" : "done"));
}

async function record(db: pg.Pool, stageRunId: string, videoId: string, sessionId: string, j: JobRow, found: JobOutcome): Promise<CheckOutcome> {
  return inTx(db, async (c): Promise<CheckOutcome> => {
    if (!(await sessionIsLive(c, sessionId))) throw new Stop(NOT_OWNER);
    const st = await c.query<{ status: string }>("select status from stage_runs where id = $1 for update", [stageRunId]);
    if (st.rows[0]?.status !== "needs_decision") throw new Stop("This step is no longer waiting for a decision.");
    const cur = await c.query<{ state: string }>("select state from media_jobs where id = $1 for update", [j.id]);
    if (cur.rows[0]?.state === "done") return "already_done";
    const outcome: CheckOutcome = found.kind;
    if (found.kind === "done") {
      const intent = await c.query<{ id: string }>(
        "select id from spend_intents where stage_run_id = $1 and step_index = $2 and status in ('pending','unknown') order by id for update",
        [stageRunId, j.step],
      );
      if (intent.rows.length !== 1) throw new Stop("This job's paid call is not open any more, so nothing was changed.");
      const actual = Number(j.quote);
      if (!(await settleCheckedJob(c, j.id, { actual, artifact: found.artifact }))) throw new Stop("This job changed while it was being checked. Nothing was changed.");
      await settleIntent(c, intent.rows[0]!.id, { actualMicroUsd: actual, result: found.artifact, providerRef: j.provider_job_id });
    }
    await recordAudit(c, "stage.job_checked", { stageRunId, videoId, provider: j.provider, jobId: j.provider_job_id, outcome, sessionId });
    return outcome;
  });
}
