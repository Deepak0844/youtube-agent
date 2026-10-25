import {
  BudgetRefusedError,
  LeaseLostError,
  NeedsDecisionError,
  runPaidCall,
  type ClaimLike,
  type PaidCallOutput,
  type PaidCallPorts,
} from "./paid-call";

// The worker body for one stage attempt: claim -> paid steps (each through runPaidCall) -> commit. No IO here;
// everything comes through ports (the Postgres adapter is src/server/db/stage-runner-adapter.ts).
//
// - The claim uses the job's inputHash (the row's hash AT ENQUEUE TIME). If the row's input changed since, the claim
//   matches nothing and the attempt is a no-op: work queued for an older input never runs.
// - A null claim (already claimed, already finished, wrong hash, needs_decision) is a normal no-op.
// - A heartbeat runs every ttl/3 while the attempt runs; once it fails the lease is treated as lost: no further step
//   starts (reserve would refuse anyway, the DB re-checks the lease) and the timer stops.
// - NeedsDecision / LeaseLost / BudgetRefused stop the attempt WITHOUT commit (NeedsDecision already parked the stage).
// - Settle (inside runPaidCall) and commit are separate transactions, settle first; nothing is paid after commit.

export interface StageJob {
  stageRunId: string;
  inputHash: string;
}

export interface StageLike {
  id: string;
  name: string;
  inputHash: string;
}

export interface StageClaim extends ClaimLike {
  leaseUntil: Date;
  jobId: string;
}

export interface StageStep {
  stepIndex: number;
  toolCallIndex: number;
  reserveMicroUsd: number;
  budgetScopes: string[];
  kind: "paid" | "cheap_text";
}

export interface StageProvider {
  call(idempotencyKey: string, step: StageStep): Promise<PaidCallOutput<unknown>>;
}

export interface StageRunnerDeps {
  provider: StageProvider;
  ttlMs: number;
  workerId: string;
  stepsFor(stage: StageLike): StageStep[];
}

export interface StageRunnerPorts {
  paid: PaidCallPorts;
  claim(args: { id: string; inputHash: string; workerId: string; ttlMs: number }): Promise<StageClaim | null>;
  heartbeat(claim: StageClaim, ttlMs: number): Promise<boolean>;
  getStage(id: string): Promise<StageLike | null>;
  commit(claim: StageClaim, result: unknown): Promise<boolean>;
}

export type StageOutcome =
  | { kind: "noop" }
  | { kind: "committed"; claim: StageClaim }
  | { kind: "commit_rejected"; claim: StageClaim }
  | { kind: "needs_decision"; claim: StageClaim }
  | { kind: "lease_lost"; claim: StageClaim }
  | { kind: "budget_refused"; claim: StageClaim };

export async function runStageWith(ports: StageRunnerPorts, deps: StageRunnerDeps, job: StageJob): Promise<StageOutcome> {
  const claim = await ports.claim({ id: job.stageRunId, inputHash: job.inputHash, workerId: deps.workerId, ttlMs: deps.ttlMs });
  if (!claim) return { kind: "noop" };

  let leaseLost = false;
  const timer = setInterval(() => {
    ports.heartbeat(claim, deps.ttlMs).then(
      (alive) => {
        if (!alive) {
          leaseLost = true;
          clearInterval(timer);
        }
      },
      () => {}, // a failed heartbeat (DB blip) just lets the lease run down; the DB clock decides
    );
  }, Math.max(1, Math.floor(deps.ttlMs / 3)));

  try {
    const stage = await ports.getStage(job.stageRunId);
    if (!stage) throw new Error(`stage ${job.stageRunId} vanished after claim`);
    const results: unknown[] = [];
    for (const step of deps.stepsFor(stage)) {
      if (leaseLost) return { kind: "lease_lost", claim };
      results.push(
        await runPaidCall(ports.paid, { claim, ...step }, (key) => deps.provider.call(key, step)),
      );
    }
    const committed = await ports.commit(claim, { steps: results });
    return { kind: committed ? "committed" : "commit_rejected", claim };
  } catch (err) {
    if (err instanceof NeedsDecisionError) return { kind: "needs_decision", claim };
    if (err instanceof LeaseLostError) return { kind: "lease_lost", claim };
    if (err instanceof BudgetRefusedError) return { kind: "budget_refused", claim };
    throw err;
  } finally {
    clearInterval(timer);
  }
}
