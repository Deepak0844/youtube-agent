import type pg from "pg";
import { actorProblem, type GateActor } from "@/server/core/approvals";
import { describeDecision, isDecisionChoice, type DecisionChoice, type DecisionIntent, type DecisionView } from "@/server/core/decision";
import { uuidv7 } from "@/server/core/ids";
import { stageJobId } from "@/server/core/job-id";
import { STAGE_NAMES, type StageName } from "@/server/core/pipeline-plan";
import { recordAudit } from "./audit";
import { admitStage } from "./breakers";
import { insertEvent } from "./events";
import { inTx, NO_DECISIONS, wantedHashLocked, type EnqueueOnly, type PipelineReaders } from "./pipeline";
import { keepUnclearIntentSpent, releaseUnclearIntent } from "./spend";
import { cancelQueuedStage, requestCancel } from "./stages";

// The human flow for a parked (needs_decision) stage, ADR 0004 section 8. The owner (a signed-in session, nothing else)
// says what happened to the money and what to do next. Money held by an unclear outcome is released or counted ONLY here.
//
// One transaction per resolve, locks in the global order: video row, stage row, the stage's intents (all FOR UPDATE), then
// budgets (inside db/spend.ts). The parked row is the thing that is claimed: whoever finds it no longer parked loses, so two
// resolves race to exactly one winner. The reconciler never selects needs_decision rows, and once resolved the old row is
// failed/cancelled (or re-queued as the SAME row for the two choices that pay nothing twice), so it cannot be revisited.
//
// A rerun is a NEW stage row (new id, therefore new call keys): a call key that may have been charged is never reused.
// The two choices that keep the same row (use_result, and raise_cap when the input is unchanged) are the ones where every
// earlier call is settled `done` or was never made, so replaying the same keys returns stored results and pays nothing.

export type ResolveResult = { ok: true; newStageRunId?: string; requeued?: boolean; rerunHeld?: boolean } | { ok: false; reason: string };

export interface DecisionDetail extends DecisionView {
  stageRunId: string;
  videoId: string;
  stage: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NOT_OWNER = "only the signed-in owner can do this";

// One raise may take a cap up to 10 times what it is now, or to $10, whichever is more.
const MAX_RAISE_FACTOR = 10;
const MIN_RAISE_ALLOWANCE_MICRO_USD = 10_000_000;

class Refusal extends Error {}
const refuse = (reason: string): never => {
  throw new Refusal(reason);
};

interface StageHead {
  id: string;
  video_id: string;
  name: string;
  status: string;
  input_hash: string;
  fence: string;
  attempt_seq: number;
  cancel_requested: boolean;
  result: unknown;
}
interface IntentRow {
  id: string;
  status: DecisionIntent["status"];
  reserved: string;
}

async function loadIntents(c: pg.Pool | pg.PoolClient, stageRunId: string, lock: boolean): Promise<IntentRow[]> {
  const r = await c.query<IntentRow>(`select id, status, reserved_micro_usd as reserved from spend_intents where stage_run_id = $1 order by id ${lock ? "for update" : ""}`, [stageRunId]);
  return r.rows;
}
const toView = (rows: IntentRow[]): DecisionIntent[] => rows.map((r) => ({ status: r.status, reservedMicroUsd: Number(r.reserved) }));

/** What the owner sees for a parked stage (plain words, dollar figure, the choices). null when the stage is not parked. Read only. */
export async function getDecision(db: pg.Pool, stageRunId: string): Promise<DecisionDetail | null> {
  if (!UUID_RE.test(stageRunId)) return null;
  const r = await db.query<StageHead>("select id, video_id, name, status, input_hash, fence, attempt_seq, cancel_requested, result from stage_runs where id = $1", [stageRunId]);
  const s = r.rows[0];
  if (!s || s.status !== "needs_decision") return null;
  const view = describeDecision({ name: s.name, status: s.status, result: s.result }, toView(await loadIntents(db, s.id, false)));
  return { ...view, stageRunId: s.id, videoId: s.video_id, stage: s.name };
}

async function sessionIsLive(c: pg.PoolClient, sessionId: string): Promise<boolean> {
  const r = await c.query("select 1 from sessions where id = $1 and revoked_at is null and expires_at > clock_timestamp() and absolute_expires_at > clock_timestamp()", [sessionId]);
  return r.rowCount === 1;
}

export interface ResolveArgs {
  stageRunId: string;
  choice: DecisionChoice;
  actor: GateActor;
  /** raise_cap_and_rerun only: the budget scope to raise and its new cap (micro-USD, strictly higher than now). */
  raiseCap?: { scope: string; capMicroUsd: number };
}

export async function resolveDecision(db: pg.Pool, queue: EnqueueOnly, a: ResolveArgs, readers: PipelineReaders = NO_DECISIONS): Promise<ResolveResult> {
  if (actorProblem(a?.actor)) return { ok: false, reason: NOT_OWNER };
  if (!isDecisionChoice(a.choice)) return { ok: false, reason: "unknown choice" };
  if (typeof a.stageRunId !== "string" || !UUID_RE.test(a.stageRunId)) return { ok: false, reason: "no such stage" };
  const sessionId = a.actor.sessionId;

  type Done = { newId: string | null; requeue: { id: string; fence: number; attemptSeq: number; inputHash: string } | null; flagged: string[]; noop?: boolean; rerunHeld?: boolean };
  let done: Done;
  try {
    done = await inTx(db, async (c): Promise<Done> => {
      if (!(await sessionIsLive(c, sessionId))) return refuse(NOT_OWNER);
      const pre = await c.query<{ video_id: string; name: string }>("select video_id, name from stage_runs where id = $1", [a.stageRunId]);
      const head = pre.rows[0];
      if (!head) return refuse("no such stage");
      const pipelineStage = (STAGE_NAMES as readonly string[]).includes(head.name);
      let want: string | null = null;
      let videoLive = false;
      if (pipelineStage) {
        // Video row first (the same order advance, cancel and retry use). A stage whose video is gone cannot be rerun.
        const exists = await c.query("select 1 from videos where id = $1", [head.video_id]);
        if (exists.rowCount === 1) {
          want = await wantedHashLocked(c, head.video_id, head.name as StageName, readers);
          const st = await c.query<{ status: string }>("select status from videos where id = $1", [head.video_id]);
          videoLive = st.rows[0]!.status === "active" || st.rows[0]!.status === "waiting";
        }
      }
      const lockedStage = await c.query<StageHead>(
        "select id, video_id, name, status, input_hash, fence, attempt_seq, cancel_requested, result from stage_runs where id = $1 for update",
        [a.stageRunId],
      );
      const s = lockedStage.rows[0]!;
      if (s.status !== "needs_decision") return refuse("this step is no longer waiting for a decision (already resolved)");
      const intents = await loadIntents(c, s.id, true);
      const view = describeDecision({ name: s.name, status: s.status, result: s.result }, toView(intents));
      if (!view.choices.includes(a.choice)) return refuse("that choice is not available for this step");

      const out: Done = { newId: null, requeue: null, flagged: [], rerunHeld: false };
      const audit: Record<string, unknown> = {
        stageRunId: s.id, videoId: pipelineStage ? s.video_id : null, stage: s.name, choice: a.choice, reason: view.reason, sessionId,
        maxCostMicroUsd: view.maxCostMicroUsd, openCalls: intents.filter((i) => i.status === "pending" || i.status === "unknown").length,
      };
      const marker = { resolved: { choice: a.choice, reason: view.reason } };

      if (a.choice === "cancel_video") {
        if (!pipelineStage) return refuse("this step belongs to no video");
        const openCalls = audit.openCalls as number;
        // Asking twice while money is still held changes nothing: the first cancel already flagged everything.
        if (!videoLive && s.cancel_requested && openCalls > 0) return { newId: null, requeue: null, flagged: [], noop: true, rerunHeld: false };
        // Only a live video becomes cancelled: a video that already ended (done, failed, cancelled) keeps its status.
        if (videoLive) await c.query("update videos set status = 'cancelled', updated_at = now() where id = $1 and status in ('active','waiting')", [s.video_id]);
        const active = await c.query<{ id: string }>("select id from stage_runs where video_id = $1 and status in ('queued','running','needs_decision') order by id", [s.video_id]);
        for (const { id } of active.rows) if (await requestCancel(c, id)) out.flagged.push(id);
        // Money that may have run keeps its reservation and the parked row stays visible (held money is never hidden). With
        // no open money there is nothing to hide, so the parked row is closed here.
        if (openCalls === 0) await c.query("update stage_runs set status = 'cancelled', result = coalesce(result, '{}'::jsonb) || $2::jsonb, updated_at = clock_timestamp() where id = $1 and status = 'needs_decision'", [s.id, JSON.stringify(marker)]);
      } else {
        const rerunChoice = a.choice === "release_and_rerun" || a.choice === "keep_spent_and_rerun";
        // Decide the shape of the follow-up BEFORE touching money, so a refusal changes nothing.
        let shape: "close" | "new_row" | "same_row";
        if (a.choice === "use_result") {
          if (!videoLive || want === null || want !== s.input_hash) return refuse("the input changed since this step ran, so its result cannot be used");
          shape = "same_row";
        } else if (a.choice === "raise_cap_and_rerun") {
          if (!videoLive || want === null) return refuse("this video cannot run this step now");
          shape = want === s.input_hash ? "same_row" : "new_row";
        } else {
          // release / keep: a fresh run (new call keys) only when no call of this row was paid, otherwise it would pay again.
          // Without a live video, or with a paid call in the row, the money is settled and the row closed.
          shape = pipelineStage && videoLive && view.rerunSafe && !intents.some((i) => i.status === "done") ? "new_row" : "close";
          if (shape === "new_row" && want === null) return refuse("an earlier step is not finished, so this step cannot run again yet");
        }
        if (s.cancel_requested && shape !== "close") return refuse("this step was cancelled");

        // Validate the cap change before the breaker is asked, so a refusal never spends a half-open probe.
        let capChange: { scope: string; old: number; next: number } | null = null;
        if (a.choice === "raise_cap_and_rerun") {
          const rc = a.raiseCap;
          if (!rc || typeof rc.scope !== "string" || rc.scope.length === 0 || !Number.isSafeInteger(rc.capMicroUsd) || rc.capMicroUsd < 0) return refuse("give the budget to raise and its new limit");
          // The scopes this video's paid calls were reserved against. A budget outside them did not refuse anything here.
          const used = await c.query<{ scope: string }>(
            "select distinct unnest(i.scopes) as scope from spend_intents i join stage_runs r on r.id = i.stage_run_id where r.video_id = $1",
            [s.video_id],
          );
          if (used.rows.length > 0 && !used.rows.some((u) => u.scope === rc.scope)) return refuse("that budget did not pay for this video's calls");
          const cur = await c.query<{ cap: string | null }>("select cap_micro_usd as cap from budgets where scope = $1 for update", [rc.scope]);
          if (!cur.rows[0]) return refuse("no such budget");
          if (cur.rows[0].cap === null) return refuse("that budget already has no limit");
          const old = Number(cur.rows[0].cap);
          if (rc.capMicroUsd <= old) return refuse("the new limit must be higher than the current one");
          if (rc.capMicroUsd > Math.max(old * MAX_RAISE_FACTOR, MIN_RAISE_ALLOWANCE_MICRO_USD)) return refuse("that limit is too high for one step: raise it by at most 10 times (or to $10) at a time");
          capChange = { scope: rc.scope, old, next: rc.capMicroUsd };
        }

        if (shape !== "close") {
          const gate = await admitStage(c, s.name);
          if (!gate.allowed) {
            // A held breaker pauses RUNNING, not bookkeeping: the money decision still goes through, the step just is not rerun.
            if (!rerunChoice) return refuse(`paused: the ${s.name} step is on hold after repeated failures${gate.until ? ` until ${gate.until.toISOString()}` : ""}. Reset it first, then decide again`);
            shape = "close";
            out.rerunHeld = true;
          }
        }

        if (capChange) {
          await c.query("update budgets set cap_micro_usd = $2 where scope = $1", [capChange.scope, capChange.next]);
          Object.assign(audit, { scope: capChange.scope, oldCapMicroUsd: capChange.old, newCapMicroUsd: capChange.next });
        } else if (rerunChoice) {
          for (const i of intents) {
            if (i.status !== "pending" && i.status !== "unknown") continue;
            const changed = a.choice === "release_and_rerun" ? await releaseUnclearIntent(c, i.id) : await keepUnclearIntentSpent(c, i.id);
            if (!changed) throw new Error("a held call changed while the decision was being made");
          }
        }

        const fence = Number(s.fence);
        if (shape === "same_row") {
          const attemptSeq = s.attempt_seq + 1;
          const q = await c.query(
            `update stage_runs set status = 'queued', lease_owner = null, lease_until = null, attempt_seq = $2, attempt_job_id = $3,
                    result = $4::jsonb, updated_at = clock_timestamp()
              where id = $1 and status = 'needs_decision'`,
            [s.id, attemptSeq, stageJobId(s.id, fence, attemptSeq), JSON.stringify(marker)],
          );
          if (q.rowCount !== 1) throw new Error("parked row changed");
          out.requeue = { id: s.id, fence, attemptSeq, inputHash: s.input_hash };
        } else {
          const closed = shape === "close" && !videoLive && pipelineStage ? "cancelled" : "failed";
          await c.query("update stage_runs set status = $2, result = coalesce(result, '{}'::jsonb) || $3::jsonb, updated_at = clock_timestamp() where id = $1 and status = 'needs_decision'", [s.id, closed, JSON.stringify(marker)]);
          if (shape === "new_row") {
            if (intents.some((i) => i.status === "done") && a.choice !== "raise_cap_and_rerun") return refuse("a paid call in this step already settled, so it cannot be run again with new keys"); // defence in depth
            const id = uuidv7();
            const ins = await c.query("insert into stage_runs (id, video_id, name, status, input_hash) values ($1,$2,$3,'queued',$4) on conflict do nothing", [id, s.video_id, s.name, want]);
            if (ins.rowCount !== 1) return refuse("another run of this step already exists"); // rolls everything back
            out.newId = id;
            out.requeue = { id, fence: 0, attemptSeq: 0, inputHash: want! };
          }
        }
        if (pipelineStage && shape !== "close") await c.query("update videos set status = 'active', updated_at = now() where id = $1", [s.video_id]);
      }

      if (out.noop) return out;
      Object.assign(audit, { newStageRunId: out.newId ?? undefined, mode: out.requeue ? (out.newId ? "new_row" : "same_row") : a.choice === "cancel_video" ? "cancel" : "close", rerunHeld: out.rerunHeld });
      await recordAudit(c, "stage.decision", audit);
      await insertEvent(c, { type: "notify", videoId: pipelineStage ? s.video_id : null, stageRunId: s.id, payload: { kind: "decision", choice: a.choice, stage: s.name } });
      return out;
    });
  } catch (e) {
    if (e instanceof Refusal) return { ok: false, reason: e.message };
    throw e;
  }
  // After the commit. If Redis is down the row stays queued and the reconciler delivers it.
  for (const id of done.flagged) await cancelQueuedStage(db, id).catch(() => undefined);
  if (done.requeue) {
    try {
      await queue.enqueue(done.requeue.id, done.requeue.fence, done.requeue.attemptSeq, done.requeue.inputHash);
    } catch {
      /* the queued row is the record; the reconciler enqueues it */
    }
  }
  return { ok: true, ...(done.newId ? { newStageRunId: done.newId } : {}), ...(done.requeue && !done.newId ? { requeued: true } : {}), ...(done.rerunHeld ? { rerunHeld: true } : {}) };
}
